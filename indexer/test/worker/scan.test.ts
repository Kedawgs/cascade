import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { FRONT_DOOR, VAULT } from "../../src/abi.ts";
import { type ChainName, rolesOf } from "../../src/config.ts";
import { identify, type RawLog } from "../../src/logs.ts";
import { Budget, createRpc } from "../../src/rpc.ts";
import { headTimeOf, REREAD, rereadRange, SETTLE, scanChain, WINDOW } from "../../src/scan.ts";
import { type ChainSpec, type FetchRecord, fakeChains, fakeClock, TEST_URLS, windowsAsked } from "./fake-rpc.ts";
import { rawLog, testConfig, tx } from "./fixtures.ts";

const d = testConfig().deployment;
const roleOf = rolesOf(d);
const BIT = [d.vault, d.bitAdapter];
const BASE = [d.frontDoor, d.baseAdapter, d.staker];

/** A vault log at `block`; `n` makes it distinct (its transaction and its amount). */
const vlog = (block: bigint, n: number, logIndex = 0): RawLog =>
  rawLog({ address: d.vault, abi: VAULT, eventName: "Staked", args: { hotkey: d.stakeHotkey, rao: BigInt(n), measured: BigInt(n) }, block, logIndex, txHash: tx(n) });
const uidOf = (chain: ChainName, l: RawLog) => identify(chain, [l])[0].uid;

function setup(
  specs: Partial<Record<ChainName, ChainSpec>>,
  o: { subrequests?: number; decode?: number; onFetch?: (f: FetchRecord) => void; clock?: ReturnType<typeof fakeClock> } = {},
) {
  const clock = o.clock ?? fakeClock();
  const net = fakeChains(specs, { onFetch: o.onFetch });
  const budget = new Budget(o.subrequests ?? 45);
  const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget, sleep: clock.sleep, now: clock.now, spacingMs: { base: 0, bittensor: 0 } });
  const decodeBudget = new Budget(o.decode ?? 300, "decode");
  const scan = (chain: ChainName, cursor: { scannedTo: bigint | null; settledTo: bigint }, more: { stored?: Map<Hex, bigint>; startBlock?: bigint; window?: bigint; deadlineMs?: number; reserve?: number } = {}) =>
    scanChain({
      rpc,
      chain,
      roleOf,
      addresses: chain === "bittensor" ? BIT : BASE,
      startBlock: more.startBlock ?? 1000n,
      cursor,
      stored: more.stored ?? new Map(),
      decodeBudget,
      deadlineMs: more.deadlineMs ?? clock.now() + 40_000,
      now: clock.now,
      window: more.window,
      reserve: more.reserve === undefined ? undefined : { budget, keep: more.reserve },
    });
  return { net, budget, decodeBudget, clock, scan };
}

const FIRST = { scannedTo: null, settledTo: 999n };

describe("scanChain on Bittensor", () => {
  it("reads a first scan from the start block in 1,000-block windows, up to the head", async () => {
    const { net, scan } = setup({ bittensor: { head: 3500n } });
    const r = await scan("bittensor", FIRST);
    expect(windowsAsked(net.fetches)).toEqual([
      [1000n, 1999n],
      [2000n, 2999n],
      [3000n, 3500n],
    ]);
    expect(r.stopped).toBeUndefined();
    expect(r.cursor).toEqual({ scannedTo: 3500n, settledTo: 3490n });
    expect(r.head).toBe(3500n);
    // it learnt the head (and its time) first, in its own request: it never asks for a window past a known head
    expect(net.fetches[0].methods).toEqual(["eth_blockNumber", "eth_getBlockByNumber"]);
    expect(r.headTime).toBe(1_700_000_000 + 3500 * 12);
  });

  it("starts a later scan REREAD blocks back, up to the last head read, then reads on to the new head", async () => {
    const { net, scan } = setup({ bittensor: { head: 3600n } });
    const r = await scan("bittensor", { scannedTo: 3500n, settledTo: 3490n });
    expect(windowsAsked(net.fetches)).toEqual([
      [3101n, 3500n],
      [3501n, 3600n],
    ]);
    expect(rereadRange("bittensor", { scannedTo: 3500n }, 1000n)).toEqual({ from: 3101n, to: 3500n });
    expect(rereadRange("bittensor", { scannedTo: 1100n }, 1000n)).toEqual({ from: 1000n, to: 1100n });
    expect(rereadRange("bittensor", { scannedTo: null }, 1000n)).toBeNull();
    expect(r.cursor).toEqual({ scannedTo: 3600n, settledTo: 3590n });
    // the head's time came with the first window, in the same request
    expect(net.fetches[0].methods).toEqual(["eth_getLogs", "eth_blockNumber", "eth_getBlockByNumber"]);
    expect(r.headTime).toBe(1_700_000_000 + 3600 * 12);
    expect(net.count()).toBe(2);
  });

  it("returns logs within SETTLE of the head without storing them, and stores them once settled", async () => {
    const deep = vlog(3480n, 1);
    const recent = vlog(3495n, 2);
    const spec: ChainSpec = { head: 3500n, logs: [deep, recent] };
    const first = await setup({ bittensor: spec }).scan("bittensor", { scannedTo: 3400n, settledTo: 3390n });
    expect(first.upserts.map((l) => l.block)).toEqual([3480n]);
    expect(first.fresh.map((l) => l.block)).toEqual([3495n]);
    expect(first.cursor.settledTo).toBe(3490n);
    // next tick: the head moved on; the deep log is stored already, the recent one now settles
    spec.head = 3510n;
    const stored = new Map([[uidOf("bittensor", deep), 3480n]]);
    const second = await setup({ bittensor: spec }).scan("bittensor", first.cursor, { stored });
    expect(second.upserts.map((l) => l.block)).toEqual([3495n]);
    expect(second.fresh).toEqual([]);
  });

  it("treats a re-mined copy as the same log, at its new block", async () => {
    const copy = vlog(3250n, 7);
    const stored = new Map([[uidOf("bittensor", vlog(3200n, 7, 3)), 3200n]]);
    const r = await setup({ bittensor: { head: 3510n, logs: [copy] } }).scan("bittensor", { scannedTo: 3500n, settledTo: 3490n }, { stored });
    expect(r.upserts.map((l) => [l.uid, l.block])).toEqual([[uidOf("bittensor", copy), 3250n]]);
    expect(r.removed).toEqual([]);
  });

  it("marks a stored log that vanished from a re-read as removed, and brings it back when it is re-mined", async () => {
    const gone = vlog(3200n, 8);
    const kept = vlog(3300n, 9);
    const stored = new Map([
      [uidOf("bittensor", gone), 3200n],
      [uidOf("bittensor", kept), 3300n],
    ]);
    const spec: ChainSpec = { head: 3510n, logs: [kept] };
    const r = await setup({ bittensor: spec }).scan("bittensor", { scannedTo: 3500n, settledTo: 3490n }, { stored });
    expect(r.removed).toEqual([uidOf("bittensor", gone)]);
    // stored and unchanged: no write needed
    expect(r.upserts).toEqual([]);
    // later it is mined again in block 3520: an upsert at its new block (the store clears the mark)
    spec.head = 3600n;
    spec.logs = [kept, { ...gone, blockNumber: "0xdc0" }];
    const again = await setup({ bittensor: spec }).scan("bittensor", r.cursor, { stored: new Map([[uidOf("bittensor", kept), 3300n]]) });
    expect(again.upserts.map((l) => [l.uid, l.block])).toEqual([[uidOf("bittensor", gone), 3520n]]);
    expect(again.removed).toEqual([]);
  });

  it("never advances the cursor on a lagging node", async () => {
    const spec: ChainSpec = { head: 3500n, logs: [vlog(1500n, 1), vlog(2100n, 2)] };
    const { net, scan } = setup(
      { bittensor: spec },
      {
        onFetch: (f) => {
          // every answer for [2000, 2999] comes from a node at 2,500
          if (windowsAsked([f]).some(([from]) => from === 2000n)) spec.behindFor = { answers: 1, head: 2500n };
        },
      },
    );
    const r = await scan("bittensor", FIRST);
    expect(r.stopped).toBe("lagging");
    expect(windowsAsked(net.fetches)).toEqual([
      [1000n, 1999n],
      [2000n, 2999n],
      [2000n, 2999n],
    ]);
    expect(r.cursor).toEqual({ scannedTo: 1999n, settledTo: 1999n });
    expect([...r.upserts, ...r.fresh].map((l) => l.block)).toEqual([1500n]);
  });

  it("accepts a window on the retry when the node has caught up", async () => {
    const spec: ChainSpec = { head: 3500n };
    let once = true;
    const { scan } = setup(
      { bittensor: spec },
      {
        onFetch: (f) => {
          if (once && windowsAsked([f]).some(([from]) => from === 2000n)) {
            once = false;
            spec.behindFor = { answers: 1, head: 2500n };
          }
        },
      },
    );
    const r = await scan("bittensor", FIRST);
    expect(r.stopped).toBeUndefined();
    expect(r.cursor.scannedTo).toBe(3500n);
  });

  it("keeps the last whole window when the subrequest budget runs out", async () => {
    const { scan } = setup({ bittensor: { head: 3500n } }, { subrequests: 3 });
    const r = await scan("bittensor", FIRST);
    expect(r.stopped).toBe("budget");
    expect(r.cursor).toEqual({ scannedTo: 2999n, settledTo: 2999n });
  });

  it("stops before a window that would eat into the reserve left for the reads and emails", async () => {
    const { budget, scan } = setup({ bittensor: { head: 3500n } }, { subrequests: 10 });
    const r = await scan("bittensor", FIRST, { reserve: 8 });
    expect(r.stopped).toBe("budget");
    expect(r.cursor.scannedTo).toBe(1999n);
    expect(budget.left).toBe(8);
  });

  it("finishes the window that spends the decode budget, then stops", async () => {
    const many = Array.from({ length: 350 }, (_, i) => vlog(1000n + BigInt(i), i + 1));
    const { decodeBudget, scan } = setup({ bittensor: { head: 3500n, logs: [...many, vlog(2500n, 999)] } }, { decode: 300 });
    const r = await scan("bittensor", FIRST);
    expect(r.stopped).toBe("decode");
    expect(r.upserts).toHaveLength(350);
    expect(r.cursor).toEqual({ scannedTo: 1999n, settledTo: 1999n });
    expect(decodeBudget.left).toBe(0);
  });

  it("starts no window after the wall-time limit", async () => {
    const clock = fakeClock();
    const { net, scan } = setup({ bittensor: { head: 10_000n } }, { clock, onFetch: (f) => void (f.methods.includes("eth_getLogs") && clock.advance(15_000)) });
    const r = await scan("bittensor", FIRST, { deadlineMs: clock.now() + 40_000 });
    expect(r.stopped).toBe("wall");
    expect(windowsAsked(net.fetches)).toHaveLength(3);
    expect(r.cursor.scannedTo).toBe(3999n);
  });

  it("counts a 429's backoff toward the wall-time limit", async () => {
    const clock = fakeClock();
    const spec: ChainSpec = { head: 10_000n };
    let windows = 0;
    const { scan } = setup(
      { bittensor: spec },
      {
        clock,
        onFetch: (f) => {
          if (!f.methods.includes("eth_getLogs")) return;
          clock.advance(13_000);
          // the second window is refused once: 13 s, a 2 s backoff, then 13 s more
          if (++windows === 2) spec.failNext = { count: 1, status: 429 };
        },
      },
    );
    const r = await scan("bittensor", FIRST, { deadlineMs: clock.now() + 40_000 });
    expect(r.stopped).toBe("wall");
    expect(r.cursor.scannedTo).toBe(2999n);
    expect(clock.slept).toContain(2000);
  });

  it("stops at the last whole window when a request fails", async () => {
    const spec: ChainSpec = { head: 3500n };
    const { scan } = setup({ bittensor: spec }, { onFetch: (f) => void (windowsAsked([f]).some(([from]) => from === 2000n) && (spec.failNext = { count: 1, status: 403 })) });
    const r = await scan("bittensor", FIRST);
    expect(r.stopped).toBe("error");
    expect(r.error).toMatch(/HTTP 403/);
    expect(r.cursor.scannedTo).toBe(1999n);
  });

  it("decodes what it stores, tagged with its role", async () => {
    const r = await setup({ bittensor: { head: 1100n, logs: [vlog(1050n, 3)] } }).scan("bittensor", FIRST);
    expect(r.upserts[0]).toMatchObject({ chain: "bittensor", contract: "vault", event: "Staked", block: 1050n, args: { rao: "3" } });
  });
});

describe("scanChain on Base", () => {
  const closed = (block: bigint, n: number) =>
    rawLog({ address: d.frontDoor, abi: FRONT_DOOR, eventName: "BatchRolled", args: { id: BigInt(n) }, block, logIndex: 0, txHash: tx(n) });

  it("uses Base's own window, 100 by default and as configured, through the logs URL", async () => {
    const a = setup({ base: { head: 1250n, logs: [closed(1100n, 1)] } });
    const r = await a.scan("base", FIRST);
    expect(windowsAsked(a.net.fetches)).toEqual([
      [1000n, 1099n],
      [1100n, 1199n],
      [1200n, 1250n],
    ]);
    expect(a.net.fetches.filter((f) => f.methods.includes("eth_getLogs")).every((f) => f.url === TEST_URLS.baseLogs)).toBe(true);
    expect(r.cursor).toEqual({ scannedTo: 1250n, settledTo: 1220n });
    expect(r.upserts.map((l) => [l.contract, l.event])).toEqual([["frontDoor", "BatchRolled"]]);

    const b = setup({ base: { head: 1250n } });
    await b.scan("base", FIRST, { window: 2000n });
    expect(windowsAsked(b.net.fetches)).toEqual([[1000n, 1250n]]);
  });
});

describe("the scan's numbers", () => {
  it("are the keeper's", () => {
    expect(WINDOW).toEqual({ base: 100n, bittensor: 1000n });
    expect(REREAD).toEqual({ base: 70n, bittensor: 400n });
    expect(SETTLE).toEqual({ base: 30n, bittensor: 10n });
  });
});

describe("headTimeOf", () => {
  it("takes the scan's head time, else the reading's, else the clock, and never goes back", () => {
    expect(headTimeOf({ scanHeadTime: 500, readingTime: 400, nowS: 900, previous: 100 })).toBe(500);
    expect(headTimeOf({ readingTime: 400, nowS: 900, previous: 100 })).toBe(400);
    expect(headTimeOf({ nowS: 900, previous: 100 })).toBe(900);
    expect(headTimeOf({ scanHeadTime: 50, nowS: 900, previous: 100 })).toBe(100);
    expect(headTimeOf({ nowS: 900, previous: null })).toBe(900);
  });
});
