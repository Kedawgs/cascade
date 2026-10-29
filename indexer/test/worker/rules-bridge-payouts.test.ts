import { encodeAbiParameters, getAddress, type Hex, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import { chunkEntries, deliveredChecks, encodePayoutsMessage, payoutList } from "../../src/crosscheck/payouts.ts";
import type { StoredLog } from "../../src/logs.ts";
import { bridgePayouts } from "../../src/rules/bridge.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import type { Snapshot } from "../../src/snapshot.ts";
import type { ChunkCheckRow, ChunkCheckWrite } from "../../src/store.ts";
import { D, h, type PayoutEntry, type PayoutFixture, payoutBatch, withArgs } from "./bridge-fixtures.ts";
import { testConfig } from "./fixtures.ts";
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

  // Task 30 adds the fixture: v3-test batch 2 chunk 0 (net = 77877092e9 − 1061267e9), whose recomputed
  // message hash is the one delivered(baseAdapter, …) reads true for.
  it.todo("recomputes v3-test batch 2 chunk 0's message hash (real bytes)");
});
