import { env } from "cloudflare:workers";
import { type Hex, hexToBigInt, keccak256, numberToHex, toBytes } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { VAULT } from "../../src/abi.ts";
import type { RawLog } from "../../src/logs.ts";
import { decode, identify } from "../../src/logs.ts";
import { rolesOf } from "../../src/config.ts";
import { countingDb, wipe } from "./d1-count.ts";
import { rawLog } from "./fixtures.ts";
import { rows, tickWorld } from "./tick-world.ts";
import { batches, chunk, V3_DEPLOYMENT } from "./v3-test-fixtures.ts";

// The recorded v3-test scenario (batches 1 and 2, batch 2's chunk 0, as the chains logged them) run through
// whole ticks, against a fake of both chains serving exactly those logs: the end-to-end check on real bytes,
// and the D1 and time measurements of plan Task 30 (printed; the bounds are asserted).

const db = env.DB;
const ours = (raws: readonly unknown[], addresses: readonly string[]) => (raws as RawLog[]).filter((l) => addresses.includes(l.address));
const block = (l: { blockNumber: string }) => hexToBigInt(l.blockNumber as Hex);
/** milliseconds for `f`, the mean of `n` runs (the local workerd clock moves in whole ms) */
const time = (n: number, f: () => unknown) => {
  const t = performance.now();
  for (let i = 0; i < n; i++) f();
  return (performance.now() - t) / n;
};

function v3World() {
  // the heads a little past the last recorded log (the fake chains' block times count back from them)
  const last = (raws: readonly unknown[]) => (raws as RawLog[]).map(block).reduce((a, b) => (a > b ? a : b));
  const w = tickWorld({ over: { DEPLOYMENT: V3_DEPLOYMENT }, heads: { base: last(chunk.base) + 100n, bittensor: last(chunk.bittensor) + 50n } });
  const d = w.cfg.deployment;
  const baseLogs = ours([...batches.base, ...chunk.base], [d.frontDoor, d.baseAdapter, d.staker]);
  const bitLogs = ours([...batches.bittensor, ...chunk.bittensor], [d.vault, d.bitAdapter]);
  w.addLogs("base", baseLogs);
  w.addLogs("bittensor", bitLogs);
  // the front door recorded this chunk's message (read at the landing block when it was recorded)
  w.state.base.delivered[`${d.baseAdapter}:${chunk.delivered.hash}`] = true;
  return w;
}

describe("the recorded v3-test scenario through the tick", () => {
  beforeAll(async () => {
    await wipe(db);
  });

  it("backfills from the deployment's start blocks, passes batches 1 and 2 and chunk 0, raises nothing; and stays inside its D1 budget", async () => {
    const w = v3World();
    const c = countingDb(db);
    const t1 = performance.now();
    const first = await w.tick({ db: c.db });
    const firstMs = performance.now() - t1;
    expect(first.outcome).toBe("done");
    const backfill = { ...c.stats };
    expect((await rows<{ batch_id: number; status: string }>("SELECT batch_id, status FROM batch_checks ORDER BY batch_id")).map((r) => [r.batch_id, r.status])).toEqual([
      [1, "ok"],
      [2, "ok"],
    ]);
    expect(first).toMatchObject({ findings: 0, catchingUp: [] });
    expect(await rows("SELECT status FROM chunk_checks")).toEqual([{ status: "awaiting_read" }]);
    w.advance();
    c.reset();
    await w.tick({ db: c.db });
    expect(await rows("SELECT status FROM chunk_checks")).toEqual([{ status: "ok" }]);
    w.advance();
    c.reset();
    const t3 = performance.now();
    expect((await w.tick({ db: c.db })).outcome).toBe("done");
    const steadyMs = performance.now() - t3;
    const steady = { ...c.stats };
    expect(await rows("SELECT alert_key FROM alerts WHERE resolved_at IS NULL")).toEqual([]);
    expect(steady.queries).toBeLessThanOrEqual(6);
    expect(steady.rowsRead).toBeLessThan(2000);
    console.log(
      `measured (local workerd, fake RPC): backfill tick ${backfill.queries} D1 queries, ${backfill.rowsRead} rows read, ${firstMs.toFixed(0)} ms wall; ` +
        `steady tick ${steady.queries} queries, ${steady.rowsRead} rows read, ${steadyMs.toFixed(0)} ms wall`,
    );
  });

  it("measures the scan's CPU per log: the recorded logs, and a full batch delivery (one block of ~205 vault logs)", () => {
    const roleOf = rolesOf(JSON.parse(V3_DEPLOYMENT, (_k, v) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v)));
    const recorded = ours([...batches.bittensor, ...chunk.bittensor], ["0x32f4c98acb181a80343cc0925b4202c35e0eb6e3", "0x5659c5929dfe7993f3db521582b0201d6bf246b7"]);
    const decodeAll = (raws: RawLog[]) => identify("bittensor", raws).map((i) => decode("bittensor", i, roleOf));
    const perRecorded = time(200, () => decodeAll(recorded)) / recorded.length;
    // a full batch: 50 deposits (mint Transfer + Deposited) and 50 redeems (burn Transfer + Redeemed), in one block
    const vault = "0x32f4c98acb181a80343cc0925b4202c35e0eb6e3" as Hex;
    const tx = keccak256(toBytes("full batch"));
    const key = keccak256(toBytes("key"));
    const user = (i: number) => numberToHex(BigInt(i) + 0x1000n, { size: 20 });
    const full: RawLog[] = [];
    let n = 0;
    const add = (eventName: string, args: Record<string, unknown>) => full.push(rawLog({ address: vault, abi: VAULT, eventName, args, block: 9_400_000n, logIndex: n++, txHash: tx }));
    add("BatchDelivered", { key, sourceChain: 8453n, frontDoor: vault, batchId: 9n, amount: 10n ** 20n });
    for (let i = 0; i < 50; i++) {
      add("Transfer", { from: "0x0000000000000000000000000000000000000000", to: user(i), value: 10n ** 18n });
      add("Deposited", { key, user: user(i), assets: 10n ** 18n, shares: 10n ** 18n });
      add("Transfer", { from: user(i + 500), to: "0x0000000000000000000000000000000000000000", value: 10n ** 18n });
      add("Redeemed", { key, user: user(i + 500), shares: 10n ** 18n, assets: 10n ** 18n });
    }
    add("PayoutBatchQueued", { key, sourceChain: 8453n, batchId: 9n, count: 50, total: 10n ** 20n, price: 10n ** 18n });
    add("Staked", { hotkey: key, rao: 10n ** 9n, measured: 10n ** 9n });
    add("Staked", { hotkey: key, rao: 10n ** 9n, measured: 10n ** 9n });
    const fullMs = time(20, () => decodeAll(full));
    console.log(
      `measured (local workerd): hashing and decoding a log ${(perRecorded * 1000).toFixed(0)} µs (recorded v3-test logs); ` +
        `a full batch delivery of ${full.length} logs ${fullMs.toFixed(1)} ms`,
    );
    expect(perRecorded).toBeGreaterThan(0);
  });
});
