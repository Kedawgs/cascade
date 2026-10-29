import { env } from "cloudflare:workers";
import { type Hex, keccak256, pad, toBytes } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { accountHalf, appendPages, rebuildPages, type SeedEvent, seedEventsOf, sharedHalf } from "../../src/seed.ts";
import { appendStatements, rebuildStatements } from "../../src/store.ts";
import { wipe } from "./d1-count.ts";
import { testConfig, tx } from "./fixtures.ts";

const d = testConfig().deployment;
const KEY = keccak256(toBytes("k")) as Hex;
const OTHER_FRONT_DOOR = "0x00000000000000000000000000000000000f00d0" as Hex;

let n = 0;
const vault = (event: string, block: bigint, args: StoredLog["args"], logIndex = 0, extra: Partial<StoredLog> = {}): StoredLog => ({
  uid: tx(9000 + ++n),
  chain: "bittensor",
  contract: "vault",
  address: d.vault,
  block,
  logIndex,
  txHash: tx(n),
  event,
  data: "0x",
  args,
  ...extra,
});
const delivered = (block: bigint, o: { frontDoor?: Hex; sourceChain?: string; batchId?: string } = {}) =>
  vault("BatchDelivered", block, { key: KEY, sourceChain: o.sourceChain ?? "8453", frontDoor: o.frontDoor ?? d.frontDoor, batchId: o.batchId ?? "3", amount: "5" });
const staked = (block: bigint, logIndex = 0) => vault("Staked", block, { hotkey: d.stakeHotkey, rao: "1", measured: "1" }, logIndex);
const chunk = (block: bigint) => vault("PayoutChunkSent", block, { key: KEY, chunk: 1, taken: 4, gross: "10", net: "9", fee: "1" });

/** `count` staked events from block 1000 on. */
const events = (count: number, from = 1000): SeedEvent[] => Array.from({ length: count }, (_, i) => ({ kind: "staked", block: String(from + i), txHash: tx(i) }));

describe("seedEventsOf", () => {
  it("keeps our front door's Base deliveries, every stake and every payout chunk, in log order", () => {
    const logs = [
      chunk(30n),
      staked(20n, 5),
      delivered(10n),
      staked(20n, 2),
      delivered(11n, { frontDoor: OTHER_FRONT_DOOR }),
      delivered(12n, { sourceChain: "1" }),
      vault("Deposited", 13n, { key: KEY, user: d.frontDoor, assets: "1", shares: "1" }),
      { ...staked(40n), contract: "frontDoor" as const, chain: "base" as const },
    ];
    const out = seedEventsOf(logs, d);
    expect(out).toEqual([
      { kind: "delivered", batchId: "3", key: KEY, txHash: logs[2].txHash, block: "10" },
      { kind: "staked", block: "20", txHash: logs[3].txHash },
      { kind: "staked", block: "20", txHash: logs[1].txHash },
      { kind: "payout", key: KEY, chunk: 1, taken: 4, txHash: logs[0].txHash, block: "30" },
    ]);
  });

  it("never includes a removed log", () => {
    expect(seedEventsOf([staked(5n), { ...staked(6n), removed: true }], d).map((e) => e.block)).toEqual(["5"]);
  });
});

describe("seed pages", () => {
  it("splits 1,201 events into pages of 500, 500 and 201", () => {
    const pages = rebuildPages(events(1201));
    expect(pages.map((p) => [p.page, p.count, p.firstBlock, p.lastBlock])).toEqual([
      [0, 500, 1000n, 1499n],
      [1, 500, 1500n, 1999n],
      [2, 201, 2000n, 2200n],
    ]);
    expect(JSON.parse(pages[2].json)).toHaveLength(201);
  });

  it("fills the last page to 500, then opens another", () => {
    const [last] = rebuildPages(events(495));
    const out = appendPages({ page: last.page, events: JSON.parse(last.json) }, events(10, 2000));
    expect(out.map((p) => [p.page, p.count, p.firstBlock, p.lastBlock])).toEqual([
      [0, 500, 1000n, 2004n],
      [1, 5, 2005n, 2009n],
    ]);
  });

  it("starts at page 0 with nothing written, and writes nothing for nothing new", () => {
    expect(appendPages(null, events(3)).map((p) => [p.page, p.count])).toEqual([[0, 3]]);
    expect(appendPages({ page: 4, events: events(2) }, [])).toEqual([]);
    expect(rebuildPages([])).toEqual([]);
  });

  it("drops a removed log when the pages are rebuilt", () => {
    const logs = [staked(5n), staked(6n), staked(7n)];
    expect(rebuildPages(seedEventsOf(logs, d))[0].count).toBe(3);
    logs[1] = { ...logs[1], removed: true };
    const again = rebuildPages(seedEventsOf(logs, d));
    expect(again[0].count).toBe(2);
    expect((JSON.parse(again[0].json) as SeedEvent[]).map((e) => e.block)).toEqual(["5", "7"]);
  });
});

describe("the pages in D1", () => {
  beforeEach(async () => {
    await wipe(env.DB);
  });
  const read = async () =>
    (await env.DB.prepare("SELECT page, first_block, last_block, count FROM seed_pages ORDER BY page").all<{ page: number; first_block: number; last_block: number; count: number }>()).results;

  it("are appended to and rebuilt by statements", async () => {
    await env.DB.batch(appendStatements(env.DB, null, events(495)));
    await env.DB.batch(appendStatements(env.DB, { page: 0, events: events(495) }, events(10, 2000)));
    expect(await read()).toEqual([
      { page: 0, first_block: 1000, last_block: 2004, count: 500 },
      { page: 1, first_block: 2005, last_block: 2009, count: 5 },
    ]);
    await env.DB.batch(rebuildStatements(env.DB, events(3)));
    expect(await read()).toEqual([{ page: 0, first_block: 1000, last_block: 1002, count: 3 }]);
  });
});

describe("the two halves", () => {
  const KEYS = ["v", "vault", "from", "next", "delivered", "staked", "payouts", "deposited", "redeemed"];
  const all: SeedEvent[] = [
    { kind: "delivered", batchId: "3", key: KEY, txHash: tx(1), block: "1000" },
    { kind: "staked", block: "1001", txHash: tx(2) },
    { kind: "payout", key: KEY, chunk: 0, taken: 2, txHash: tx(3), block: "1002" },
  ];

  it("the shared half is ScanState v1 with the account lists empty", () => {
    const s = sharedHalf({ vault: d.vault, from: 1000n, next: 1003n, events: all });
    expect(Object.keys(s)).toEqual(KEYS);
    expect(s).toEqual({
      v: 1,
      vault: d.vault,
      from: "1000",
      next: "1003",
      delivered: [{ batchId: "3", key: KEY, txHash: tx(1), block: "1000" }],
      staked: [{ block: "1001", txHash: tx(2) }],
      payouts: [{ key: KEY, chunk: 0, taken: 2, txHash: tx(3), block: "1002" }],
      deposited: [],
      redeemed: [],
    });
  });

  it("the account half is ScanState v1 with the deployment lists empty", () => {
    const dep = { key: KEY, txHash: tx(4), block: "1001", assets: "40000000000000000" };
    const s = accountHalf({ vault: d.vault, from: 1000n, next: 1003n, deposited: [dep], redeemed: [] });
    expect(Object.keys(s)).toEqual(KEYS);
    expect(s).toMatchObject({ v: 1, vault: d.vault, from: "1000", next: "1003", delivered: [], staked: [], payouts: [], deposited: [dep], redeemed: [] });
  });

  it("hold only events in [from, next), with the vault lowercase", () => {
    const s = sharedHalf({ vault: d.vault.toUpperCase().replace("0X", "0x") as Hex, from: 1001n, next: 1002n, events: all });
    expect(s.vault).toBe(d.vault);
    expect([...s.delivered, ...s.staked, ...s.payouts].map((e) => e.block)).toEqual(["1001"]);
    const a = accountHalf({ vault: d.vault, from: 1000n, next: 1001n, deposited: [{ key: KEY, txHash: tx(4), block: "1001", assets: "1" }], redeemed: [] });
    expect(a.deposited).toEqual([]);
    expect(pad("0x01")).toHaveLength(66);
  });
});
