import { env } from "cloudflare:workers";
import { type Hex, keccak256, numberToHex, pad, toBytes } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { afterSettled, logQuery, prefetch, type PrefetchNeeds, twice } from "../../src/rules/context.ts";
import { type Rule, runRules } from "../../src/rules/index.ts";
import { insertTxs, loadTickState, upsertBatchCheck, upsertBlocks, upsertChunkCheck, upsertLogs } from "../../src/store.ts";
import { countingDb, wipe } from "./d1-count.ts";
import { tx } from "./fixtures.ts";
import { bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";

const db = env.DB;
const h = (s: string) => keccak256(toBytes(s)) as Hex;
const word = (n: bigint) => pad(numberToHex(n));

describe("runRules", () => {
  it("keeps going past a rule that throws, which becomes one monitor.rule_failed finding", () => {
    const rules: Rule[] = [
      { name: "a", run: () => [{ rule: "keeper.low_eth", key: "keeper.low_eth", subject: "a", facts: {} }] },
      {
        name: "boom",
        run: () => {
          throw new Error("cannot read properties of undefined");
        },
      },
      { name: "c", run: () => [{ rule: "keeper.low_tao", key: "keeper.low_tao", subject: "c", facts: {} }] },
    ];
    const out = runRules(rules, ruleCtx());
    expect(out.map((f) => f.rule)).toEqual(["keeper.low_eth", "monitor.rule_failed", "keeper.low_tao"]);
    expect(out[1]).toMatchObject({ key: "monitor.rule_failed:boom", facts: { rule: "boom", error: "cannot read properties of undefined" } });
  });
});

describe("twice", () => {
  const low = (s: { bittensor?: { price?: bigint } }) => (s.bittensor?.price ?? 0n) < 100n;
  it("holds only when the previous reading held too, from an older block", () => {
    const first = ruleCtx({ snap: { ...ruleCtx().snap, bittensor: reading(11n, 1, bitState({ price: 50n })) }, previous: { bittensor: reading(10n, 0, bitState({ price: 500n })) } });
    expect(twice(first, "bittensor", low)).toBe(false);
    const second = ruleCtx({ snap: { ...ruleCtx().snap, bittensor: reading(12n, 2, bitState({ price: 50n })) }, previous: { bittensor: reading(11n, 1, bitState({ price: 50n })) } });
    expect(twice(second, "bittensor", low)).toBe(true);
    const notNewer = ruleCtx({ snap: { ...ruleCtx().snap, bittensor: reading(11n, 2, bitState({ price: 50n })) }, previous: { bittensor: reading(11n, 1, bitState({ price: 50n })) } });
    expect(twice(notNewer, "bittensor", low)).toBe(false);
    const noReading = ruleCtx({ previous: { bittensor: reading(11n, 1, bitState({ price: 50n })) } });
    expect(twice(noReading, "bittensor", low)).toBe(false);
  });
});

describe("afterSettled", () => {
  it("is false until the other chain's settled time passes the event's time", () => {
    const ctx = ruleCtx({ settled: { base: { block: 100n, time: 1000 }, bittensor: { block: 50n, time: 990 } } });
    expect(afterSettled(ctx, "base", 1001)).toBe(false);
    expect(afterSettled(ctx, "base", 1000)).toBe(true);
    expect(afterSettled(ctx, "bittensor", 995)).toBe(false);
  });
});

describe("logQuery", () => {
  it("answers by contract, event and block range, and by transaction in log order, without removed logs", () => {
    const t1 = tx(1);
    const logs: StoredLog[] = [
      slog({ contract: "vault", event: "Staked", block: 5n, logIndex: 2, txHash: t1 }),
      slog({ contract: "vault", event: "Deposited", block: 5n, logIndex: 1, txHash: t1 }),
      slog({ contract: "vault", event: "Staked", block: 9n }),
      slog({ contract: "vault", event: "Staked", block: 7n, removed: true }),
      slog({ contract: "frontDoor", event: "Staked", block: 6n }),
    ];
    const q = logQuery(logs);
    expect(q.range("bittensor", "vault", "Staked").map((l) => l.block)).toEqual([5n, 9n]);
    expect(q.range("bittensor", "vault", ["Staked", "Deposited"], 5n, 5n).map((l) => l.event)).toEqual(["Deposited", "Staked"]);
    expect(q.inTx("bittensor", t1).map((l) => l.logIndex)).toEqual([1, 2]);
    // the same uid given twice (stored, then this tick's copy) is one log, the later one
    const again = logQuery([...logs, { ...logs[2], block: 10n }]);
    expect(again.range("bittensor", "vault", "Staked").map((l) => l.block)).toEqual([5n, 10n]);
  });
});

describe("prefetch", () => {
  const FD = "0x8a825738d0287d0959957a0f6ec18ba1276d209d" as Hex;
  const KEY = h("batch 43");
  const deliveryTx = h("delivery tx");
  const closeTx = h("close tx");
  const fd = (event: string, block: bigint, logIndex: number, o: Partial<StoredLog> = {}) => slog({ contract: "frontDoor", event, chain: "base", address: FD, block, logIndex, ...o });

  beforeEach(async () => {
    await wipe(db);
    // a long unrelated history: a steady tick must not read it
    const history = Array.from({ length: 800 }, (_, i) => slog({ contract: "vault", event: "Staked", block: BigInt(1000 + i), logIndex: 0 }));
    const baseHistory = Array.from({ length: 800 }, (_, i) => fd("DepositRequested", BigInt(10_000 + i), 0, { topic1: word(BigInt(i % 40)) }));
    await db.batch([
      ...upsertLogs(db, [...history, ...baseHistory]),
      ...upsertLogs(db, [
        // batch 43 on Base: two requests, a cancel, the close (after its adapter Sent) in its own transaction
        fd("DepositRequested", 20_000n, 0, { topic1: word(43n) }),
        fd("RedeemRequested", 20_001n, 0, { topic1: word(43n) }),
        fd("DepositCancelled", 20_002n, 0, { topic1: word(43n) }),
        slog({ contract: "baseAdapter", event: "Sent", chain: "base", block: 20_003n, logIndex: 4, txHash: closeTx }),
        fd("BatchClosed", 20_003n, 5, { topic1: word(43n), txHash: closeTx }),
        // its delivery on Bittensor: four logs in one transaction
        slog({ contract: "vault", event: "BatchDelivered", block: 3000n, logIndex: 10, txHash: deliveryTx, topic1: KEY, args: { batchId: "43" } }),
        slog({ contract: "vault", event: "Deposited", block: 3000n, logIndex: 12, txHash: deliveryTx, topic1: KEY }),
        slog({ contract: "vault", event: "Transfer", block: 3000n, logIndex: 11, txHash: deliveryTx }),
        slog({ contract: "bitAdapter", event: "Delivered", block: 3000n, logIndex: 13, txHash: deliveryTx }),
      ]),
      upsertBatchCheck(db, { batchId: 43n, deliveredKey: KEY, deliveredUid: h("u"), deliveredTx: deliveryTx, status: "waiting" }),
      upsertChunkCheck(db, { landedUid: h("landed"), batchKey: KEY, chunk: 0, landedTx: h("landing tx"), landedBlock: 20_100n, status: "waiting" }),
      ...upsertBlocks(db, [{ chain: "bittensor", number: 3000n, time: 1_800_000_000 }]),
      ...insertTxs(db, [{ chain: "base", hash: closeTx, from: "0x00000000000000000000000000000000000000a3" }]),
    ]);
  });

  const steady: PrefetchNeeds = { since: { base: 20_090n, bittensor: 3_990n }, batchIds: [], bitTxs: [], baseTxs: [], payoutKeys: [], txHashes: [], blocks: [], requestsSince: 20_090n };

  it("loads a delivery's transaction in log order, its batch's front door history and the close's transaction, in one query", async () => {
    const c = countingDb(db);
    const p = await prefetch(c.db, { ...steady, batchIds: [43n], bitTxs: [deliveryTx], txHashes: [closeTx], blocks: [{ chain: "bittensor", number: 3000n }] });
    expect(c.stats.queries).toBe(1);
    const q = logQuery(p.logs);
    expect(q.inTx("bittensor", deliveryTx).map((l) => l.event)).toEqual(["BatchDelivered", "Transfer", "Deposited", "Delivered"]);
    expect(q.range("base", "frontDoor", ["DepositRequested", "RedeemRequested", "DepositCancelled", "RedeemCancelled", "BatchClosed"]).filter((l) => l.topic1 === word(43n)).map((l) => l.event)).toEqual([
      "DepositRequested",
      "RedeemRequested",
      "DepositCancelled",
      "BatchClosed",
    ]);
    expect(q.inTx("base", closeTx).map((l) => l.event)).toEqual(["Sent", "BatchClosed"]);
    expect(p.batchChecks.map((r) => [r.batchId, r.status])).toEqual([[43n, "waiting"]]);
    expect(p.txs.map((r) => r.hash)).toEqual([closeTx]);
    expect(p.blockTimes.get("bittensor:3000")).toBe(1_800_000_000);
  });

  it("loads a payout key's chunks and landings' checks", async () => {
    const p = await prefetch(db, { ...steady, payoutKeys: [KEY] });
    expect(p.chunkChecks.map((r) => r.landedUid)).toEqual([h("landed")]);
  });

  it("reads under 500 rows on a steady tick", async () => {
    const c = countingDb(db);
    await prefetch(c.db, steady);
    expect(c.stats.queries).toBe(1);
    expect(c.stats.rowsRead).toBeLessThan(500);
  });

  it("the tick's load carries the checks still open", async () => {
    const s = await loadTickState(db, 1);
    expect(s.openChecks.batches.map((r) => r.deliveredTx)).toEqual([deliveryTx]);
    expect(s.openChecks.chunks.map((r) => r.landedTx)).toEqual([h("landing tx")]);
  });
});
