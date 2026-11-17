import { type Address, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { VAULT_ABI_V32 } from "../src/keeper/core/abi.ts";
import { event, scanLogs, scanLogsInParts } from "../src/keeper/core/logs.ts";
import { encodeMemory, freshMemory, type KeeperMemory, loadMemory } from "../src/keeper/core/memory.ts";
import { CLAIM_POLICY } from "../src/config.ts";
import { memoryJournal } from "../src/keeper/core/journal.ts";
import { type Payout, type PayoutLog, payoutsHash } from "../src/keeper/core/payouts.ts";
import { runRound } from "../src/keeper/core/round.ts";
import { targetV32 } from "../src/keeper/core/v32/actions.ts";
import { RpcError } from "../src/rpc.ts";
import { ADDR, deploymentFor, depsFor, rpcOf, T, TAO, type World, world } from "./keeper-v32-world.ts";

// A log scan keeps its progress window by window (the controller's fix after Task 51; the T50b re-review's concern 1):
// the Worker stops reading at 90 s a run (its metered RPC refuses with "out of time"), so a long scan (a Bittensor
// catch-up at the archive node's pace, a payout rescan, a memory reset) must keep what it scanned in full, or the next
// run starts it again from the same block for good. On fake chains: the v3.2 world's Bittensor scans from the start
// block 100 to the head 10,000 in the core's 1,000-block windows, so 10 windows: 100-1,099, ..., 9,100-10,000.

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const KEY_A: Hex = `0x${"ab".repeat(32)}`;
/** The Worker's read deadline, as its meter refuses the next request */
const outOfTime = () => new RpcError("out of time, the next run reads on", -32000);
/** The end of window `n` (from 1) of the scan from block 100 */
const endOf = (n: number) => 100n + BigInt(n) * 1_000n - 1n;
/** A redeem in batch KEY_A at each of these blocks: one in each of the 10 windows, two in window 3 */
const BLOCKS = [150n, 1_200n, 2_100n, 3_050n, 3_090n, 4_500n, 5_000n, 6_600n, 7_100n, 8_000n, 9_200n];

function redeems(w: World) {
  BLOCKS.forEach((block, i) => w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key: KEY_A, user: at(`a${i}`), shares: TAO, assets: TAO }, block }));
}
const redeemedCursor = (m: KeeperMemory) => (m.reads.v32 as { redeemed?: { scannedTo?: bigint; kept: PayoutLog[] } }).redeemed;
const bouncedCursor = (m: KeeperMemory) => (m.reads.v32 as { bounced?: { scannedTo?: bigint } }).bounced;
const bittensorQueries = (w: World) => w.logQueries.filter((q) => q.chain === "bittensor");

describe("a log scan keeps its progress window by window", () => {
  it("scanLogsInParts: a scan cut off after 3 of 10 windows gives the logs of those 3 and the end of the third; scanLogs (v3-launch's) is as it was, all or the error", async () => {
    const w = world();
    redeems(w);
    w.logsFail = (n) => (n === 4 ? outOfTime() : undefined);
    const ev = event(VAULT_ABI_V32, "Redeemed");
    const part = await scanLogsInParts({ rpc: rpcOf(w) }, "bittensor", ADDR.vault, ev, 100n, [], 10_000n);
    expect(part.scannedTo).toBe(endOf(3));
    expect(part.logs.map((l) => l.blockNumber)).toEqual([150n, 1_200n, 2_100n, 3_050n, 3_090n]);
    expect((part.stopped?.error as Error).message).toBe("out of time, the next run reads on");
    // nothing scanned in full: the cursor stays before the scan
    w.logsFail = () => outOfTime();
    expect((await scanLogsInParts({ rpc: rpcOf(w) }, "bittensor", ADDR.vault, ev, 100n, [], 10_000n)).scannedTo).toBe(99n);
    // scanLogs: the same windows, and the error itself thrown; complete, every log
    w.logsFail = (n) => (n === 4 ? outOfTime() : undefined);
    w.logQueries = [];
    await expect(scanLogs({ rpc: rpcOf(w) }, "bittensor", ADDR.vault, ev, 100n, [], 10_000n)).rejects.toThrow("out of time, the next run reads on");
    expect(w.logQueries.map((q) => q.from)).toEqual([100n, 1_100n, 2_100n]);
    w.logsFail = undefined;
    const all = await scanLogs({ rpc: rpcOf(w) }, "bittensor", ADDR.vault, ev, 100n, [], 10_000n);
    expect(all.map((l) => l.blockNumber)).toEqual(BLOCKS);
  });

  it("a scan cut off after 3 of 10 windows saves the cursor at the end of the third; the next run finishes it, and each event is seen once", async () => {
    const w = world();
    redeems(w);
    // the Worker's deadline before the 4th window of the first scan this run makes (the redeems: payoutLogs reads the
    // bounces first, then the redeems)
    let n = 0;
    w.logsFail = () => (++n === 10 + 4 ? outOfTime() : undefined);
    const first = freshMemory();
    await expect(depsFor(w, first).deps.payoutLogs()).rejects.toThrow("out of time, the next run reads on");
    // the bounces were scanned in full (10 windows), the redeems through window 3
    expect(bouncedCursor(first)?.scannedTo).toBe(10_000n);
    expect(redeemedCursor(first)?.scannedTo).toBe(endOf(3));
    expect(redeemedCursor(first)?.kept.map((l) => l.blockNumber)).toEqual([150n, 1_200n, 2_100n, 3_050n, 3_090n]);
    // the run's memory, saved and loaded: the next run reads on from there, REREAD blocks back, never skipping one
    w.logsFail = undefined;
    w.logQueries = [];
    const next = loadMemory(encodeMemory(first)).memory;
    const logs = await depsFor(w, next).deps.payoutLogs();
    // the bounces' one window from their head, then the redeems' from the end of window 3, contiguous to the head
    const [bounced, ...redeemed] = bittensorQueries(w);
    expect(bounced.from).toBe(10_000n + 1n - 400n);
    expect(redeemed[0].from).toBe(endOf(3) + 1n - 400n);
    redeemed.slice(1).forEach((q, i) => expect(q.from).toBe(redeemed[i].to + 1n));
    expect(redeemed.at(-1)?.to).toBe(10_000n);
    expect(redeemedCursor(next)?.scannedTo).toBe(10_000n);
    // each event once: in the scan's result, and in what the cursor keeps
    expect(logs.filter((l) => l.kind === "redeemed").map((l) => l.blockNumber)).toEqual(BLOCKS);
    expect(redeemedCursor(next)?.kept.map((l) => l.blockNumber)).toEqual(BLOCKS);
    // and a third run, with nothing new, still once each
    const third = loadMemory(encodeMemory(next)).memory;
    expect((await depsFor(w, third).deps.payoutLogs()).filter((l) => l.kind === "redeemed").map((l) => l.blockNumber)).toEqual(BLOCKS);
  });

  it("an error inside window 4 (a log the node answered that can't be decoded) saves the end of window 3; a node down before any window leaves the cursor as it was", async () => {
    const w = world();
    redeems(w);
    let n = 0;
    w.logsFail = () => (++n === 10 + 4 ? "malformed" : undefined);
    const m = freshMemory();
    await expect(depsFor(w, m).deps.payoutLogs()).rejects.toThrow();
    expect(redeemedCursor(m)?.scannedTo).toBe(endOf(3));
    expect(redeemedCursor(m)?.kept.map((l) => l.blockNumber)).toEqual([150n, 1_200n, 2_100n, 3_050n, 3_090n]);
    // the next run reads on; a node error before its first window keeps the cursor where it was, never moves it back
    const again = loadMemory(encodeMemory(m)).memory;
    w.logsFail = (k) => (k === 1 ? undefined : new RpcError("the node is down", -32000));
    w.logQueries = [];
    await expect(depsFor(w, again).deps.payoutLogs()).rejects.toThrow("the node is down");
    expect(redeemedCursor(again)?.scannedTo).toBe(endOf(3));
    w.logsFail = undefined;
    const done = loadMemory(encodeMemory(again)).memory;
    expect((await depsFor(w, done).deps.payoutLogs()).filter((l) => l.kind === "redeemed").map((l) => l.blockNumber)).toEqual(BLOCKS);
  });
});

describe("the scans' margins at the measured block time (Base's 200 ms blocks), and never a round starting past the last settled point", () => {
  it("re-reads 4,800 s of Bittensor's blocks (400 at 12 s, 800 at 6 s) and settles 120 s (10, 20)", async () => {
    const w = world();
    redeems(w);
    w.blockS.bittensor = 6;
    const first = freshMemory();
    await depsFor(w, first).deps.payoutLogs();
    expect(redeemedCursor(first)?.scannedTo).toBe(10_000n);
    w.head.bittensor = 10_050n;
    w.logQueries = [];
    const next = loadMemory(encodeMemory(first)).memory;
    await depsFor(w, next).deps.payoutLogs();
    // 4,800 s at 6 s a block: 800 blocks back from the last head
    expect(bittensorQueries(w).map((q) => q.from)).toEqual([10_000n + 1n - 800n, 10_000n + 1n - 800n]);
  });

  it("a block time read slower after a halt shortens the re-read: the round still starts no later than the last round's head less its settle margin, plus 1, so no log between is lost", async () => {
    const w = world();
    // a redeem 5 blocks below the head: within the settle margin (10 of 12 s blocks), so this round returns it but keeps
    // it for next round to read again
    w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key: KEY_A, user: at("e1"), shares: TAO, assets: TAO }, block: 9_995n });
    const first = freshMemory();
    const one = await depsFor(w, first).deps.payoutLogs();
    expect(one.filter((l) => l.kind === "redeemed").map((l) => l.blockNumber)).toEqual([9_995n]);
    expect(redeemedCursor(first)?.kept).toEqual([]);
    // the chain halted for hours: its block time reads 4,800 s now, so 4,800 s and 120 s are one block each
    w.head.bittensor = 10_003n;
    w.blockS.bittensor = 4_800;
    w.logQueries = [];
    const next = loadMemory(encodeMemory(first)).memory;
    const two = await depsFor(w, next).deps.payoutLogs();
    // the re-read alone would start at 10,000; the bound starts at 9,991 (the last head 10,000 less its 10, plus 1)
    expect(bittensorQueries(w).map((q) => q.from)).toEqual([9_991n, 9_991n]);
    expect(two.filter((l) => l.kind === "redeemed").map((l) => l.blockNumber)).toEqual([9_995n]);
    expect(redeemedCursor(next)?.kept.map((l) => l.blockNumber)).toEqual([9_995n]);
  });

  it("a block time read faster lengthens the re-read: a round never reads below what its kept ids still remember, so no log is taken twice", async () => {
    const w = world();
    redeems(w);
    const first = freshMemory();
    await depsFor(w, first).deps.payoutLogs();
    // Bittensor reads 1.2 s a block now: 4,800 s is 4,000 blocks, past what the last round's 400 kept ids for
    w.head.bittensor = 10_050n;
    w.blockS.bittensor = 1.2;
    w.logQueries = [];
    const next = loadMemory(encodeMemory(first)).memory;
    const logs = await depsFor(w, next).deps.payoutLogs();
    // from where the kept ids reach (the last head 10,000 less 400, plus 1), not 4,000 back
    expect(bittensorQueries(w).map((q) => q.from)).toEqual([9_601n, 9_601n]);
    expect(logs.filter((l) => l.kind === "redeemed").map((l) => l.blockNumber)).toEqual(BLOCKS);
    expect(redeemedCursor(next)?.kept.map((l) => l.blockNumber)).toEqual(BLOCKS);
    // the rounds after, at the same speed: once the kept ids reach back that far again, the full 4,000
    w.head.bittensor = 20_000n;
    w.logQueries = [];
    const third = loadMemory(encodeMemory(next)).memory;
    const again = await depsFor(w, third).deps.payoutLogs();
    expect(bittensorQueries(w)[0].from).toBe(9_601n);
    expect(again.filter((l) => l.kind === "redeemed").map((l) => l.blockNumber)).toEqual(BLOCKS);
    w.head.bittensor = 21_000n;
    w.logQueries = [];
    const fourth = loadMemory(encodeMemory(third)).memory;
    const last = await depsFor(w, fourth).deps.payoutLogs();
    expect(bittensorQueries(w)[0].from).toBe(20_000n + 1n - 4_000n);
    expect(last.filter((l) => l.kind === "redeemed").map((l) => l.blockNumber)).toEqual(BLOCKS);
  });
});

describe("the margins across runs: the last measured block time kept in the memory, and a cursor saved before the margins were time", () => {
  /** Bittensor's headers flat from `head` back (every span reads no time): its block time can't be read this run. */
  const unreadable = (w: World) => {
    for (const back of [0n, 300n, 600n]) w.blockTimes[`bittensor:${w.head.bittensor - back}`] = w.time.bittensor;
  };
  const clear = (w: World) => {
    for (const k of Object.keys(w.blockTimes)) delete w.blockTimes[k];
  };

  it("a run that can't read the block time counts its margins at the last one measured (kept in the memory), never at the old 12 s, so the next run's full re-read is still there (review I-1)", async () => {
    const w = world();
    redeems(w);
    // Bittensor at 6 s a block: 4,800 s is 800 blocks; the fallback's 12 s would make it 400
    w.blockS.bittensor = 6;
    const first = freshMemory();
    await depsFor(w, first).deps.payoutLogs();
    expect((first.reads.v32 as { blockS?: Record<string, number> }).blockS).toMatchObject({ bittensor: 6 });
    // the next run (a new RPC, as each Worker run makes) can't read Bittensor's block time: 800 back still
    w.head.bittensor = 10_050n;
    unreadable(w);
    w.logQueries = [];
    const second = loadMemory(encodeMemory(first)).memory;
    await depsFor(w, second).deps.payoutLogs();
    expect(bittensorQueries(w).map((q) => q.from)).toEqual([10_000n + 1n - 800n, 10_000n + 1n - 800n]);
    // and the run after, measuring again, re-reads its full 800 from the last head
    w.head.bittensor = 10_100n;
    clear(w);
    w.logQueries = [];
    const third = loadMemory(encodeMemory(second)).memory;
    const logs = await depsFor(w, third).deps.payoutLogs();
    expect(bittensorQueries(w).map((q) => q.from)).toEqual([10_050n + 1n - 800n, 10_050n + 1n - 800n]);
    expect(logs.filter((l) => l.kind === "redeemed").map((l) => l.blockNumber)).toEqual(BLOCKS);
    // never measured at all: the old 12 s (400 blocks)
    const fresh = world();
    redeems(fresh);
    unreadable(fresh);
    const none = freshMemory();
    await depsFor(fresh, none).deps.payoutLogs();
    fresh.head.bittensor = 10_050n;
    unreadable(fresh);
    fresh.logQueries = [];
    await depsFor(fresh, loadMemory(encodeMemory(none)).memory).deps.payoutLogs();
    expect(bittensorQueries(fresh).map((q) => q.from)).toEqual([10_000n + 1n - 400n, 10_000n + 1n - 400n]);
  });

  it("a cursor saved before the margins were time (no seenFrom) never re-reads below the ids it kept: the old 400 blocks of Bittensor's re-read (review M-1)", async () => {
    const w = world();
    redeems(w);
    // a redeem 700 blocks below the last head: kept, and its id let go of by the old code (beyond its 400-block re-read)
    w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key: KEY_A, user: at("f1"), shares: TAO, assets: TAO }, block: 9_300n });
    const first = freshMemory();
    await depsFor(w, first).deps.payoutLogs();
    // as the code before stored it: scannedTo, kept and seen (ids of the last 400 blocks), no settledTo or seenFrom
    const v32 = first.reads.v32 as Record<string, { settledTo?: bigint; seenFrom?: bigint } | undefined>;
    for (const name of ["bounced", "redeemed"]) {
      delete v32[name]?.settledTo;
      delete v32[name]?.seenFrom;
    }
    delete (first.reads.v32 as { blockS?: unknown }).blockS;
    // Bittensor read at 6 s now: a re-read of 800 would take 9,300 a second time
    w.head.bittensor = 10_050n;
    w.blockS.bittensor = 6;
    w.logQueries = [];
    const next = loadMemory(encodeMemory(first)).memory;
    const logs = await depsFor(w, next).deps.payoutLogs();
    expect(bittensorQueries(w).map((q) => q.from)).toEqual([10_000n + 1n - 400n, 10_000n + 1n - 400n]);
    const redeemed = logs.filter((l) => l.kind === "redeemed").map((l) => l.blockNumber);
    expect(redeemed.filter((b) => b === 9_300n)).toHaveLength(1);
  });

  it("an old cursor's settled point is seeded too: a re-read shorter than the old settle margin still reaches the logs that code returned but didn't keep (review Minor 2)", async () => {
    const w = world();
    // a redeem 5 blocks below the head: inside the old settle margin (10 blocks), returned but not kept
    w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key: KEY_A, user: at("f2"), shares: TAO, assets: TAO }, block: 9_995n });
    const first = freshMemory();
    await depsFor(w, first).deps.payoutLogs();
    const v32 = first.reads.v32 as Record<string, { settledTo?: bigint; seenFrom?: bigint } | undefined>;
    for (const name of ["bounced", "redeemed"]) {
      delete v32[name]?.settledTo;
      delete v32[name]?.seenFrom;
    }
    delete (first.reads.v32 as { blockS?: unknown }).blockS;
    // Bittensor read at 4,800 s a block now (a halt): its re-read is one block, shorter than the old 10
    w.head.bittensor = 10_003n;
    w.blockS.bittensor = 4_800;
    w.logQueries = [];
    const next = loadMemory(encodeMemory(first)).memory;
    const logs = await depsFor(w, next).deps.payoutLogs();
    // from the block after the old settled point (10,000 less its 10), not the re-read's 10,000
    expect(bittensorQueries(w).map((q) => q.from)).toEqual([9_991n, 9_991n]);
    expect(logs.filter((l) => l.kind === "redeemed").map((l) => l.blockNumber)).toEqual([9_995n]);
    expect(redeemedCursor(next)?.kept.map((l) => l.blockNumber)).toEqual([9_995n]);
  });
});

describe("a payout rescan that spans runs keeps its 'rescanned once' flag (T51 review I1)", () => {
  /** A payout batch due with one redeem in its logs, liquid TAO to pay it, and the vault's stored hash `stored` */
  function mismatched(w: World, stored: Payout[]) {
    const list: Payout[] = [{ user: at("a1"), shares: TAO, assets: TAO }];
    w.door.canClose = false;
    w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key: KEY_A, user: list[0].user, shares: TAO, assets: TAO }, block: 5_000n });
    w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "PayoutBatchQueued", args: { key: KEY_A, sourceChain: 8453n, batchId: 7n, count: 1, total: TAO, price: 10n ** 12n }, block: 5_050n });
    w.vault.batches[KEY_A.toLowerCase()] = { sourceChain: 8453n, frontDoor: ADDR.frontDoor, batchId: 7n, queuedAt: BigInt(T - 2 * 86_400), cursor: 0, count: 1, chunk: 0, remaining: TAO, payoutsHash: payoutsHash(stored) };
    w.vault.pending += TAO;
    w.vault.balance = TAO + 10n ** 15n;
    return list;
  }
  /** Runs one invocation a minute apart (the memory through JSON) until the keeper stops or `max` runs; from the second
   * on, the Worker's read deadline refuses Bittensor's log reads past `perRun` a run. */
  async function runs(w: World, max: number, perRun: number, between: (i: number) => void = () => undefined) {
    const lines: string[] = [];
    const journal = memoryJournal();
    let saved = encodeMemory(freshMemory());
    let used = 0;
    let deadline = false;
    w.logsFail = (_n, chain) => (deadline && chain === "bittensor" && ++used > perRun ? outOfTime() : undefined);
    for (let i = 0; i < max; i++) {
      between(i);
      deadline = i > 0;
      used = 0;
      const memory = loadMemory(saved).memory;
      const now = (T + i * 60) * 1000;
      const r = await runRound(depsFor(w, memory, deploymentFor(), (l) => lines.push(l), { journal }).deps, targetV32(deploymentFor()), memory, { intervalMs: 60_000, policy: CLAIM_POLICY, rewardsEveryTicks: 1000, now: () => now });
      saved = encodeMemory(r.memory);
      if (r.end) return { lines, end: r.end, runs: i + 1, memory: loadMemory(saved).memory };
    }
    return { lines, end: undefined, runs: max, memory: loadMemory(saved).memory };
  }
  const rescans = (lines: string[]) => lines.filter((l) => l.includes("the vault's events are scanned again in full"));
  const cutOff = (lines: string[]) => lines.filter((l) => /^(Failed this round|STILL FAILING) .*out of time, the next run reads on/.test(l));

  it("a list that doesn't match, rescanned once over several runs each cut off by the read deadline, then still not matching: the keeper stops (two full scans, then stop)", async () => {
    const w = world();
    // the vault stored another list than its events give
    mismatched(w, [{ user: at("a1"), shares: TAO, assets: 2n * TAO }]);
    const r = await runs(w, 12, 12);
    expect(rescans(r.lines)).toHaveLength(1);
    expect(cutOff(r.lines).length).toBeGreaterThanOrEqual(3);
    expect(r.end?.kind).toBe("payout-list");
    expect(r.end?.reason).toMatch(/does not match batch 0xabababab… \(1 entries\); nothing sent$/);
  });

  it("once the rescan's list matches, the payout goes and the flag is let go; a batch gone meanwhile lets it go too", async () => {
    // the first scan was short (here: the vault's list read wrong once); the rescan, spread over runs, gives the right one
    const w = world();
    const list = mismatched(w, [{ user: at("a1"), shares: TAO, assets: 2n * TAO }]);
    const r = await runs(w, 12, 12, (i) => {
      if (i === 1) w.vault.batches[KEY_A.toLowerCase()].payoutsHash = payoutsHash(list);
      // the payout went: the batch is paid out
      if (w.sends.some((s) => s.fn === "processPayouts")) delete w.vault.batches[KEY_A.toLowerCase()];
    });
    expect(r.end).toBeUndefined();
    expect(rescans(r.lines)).toHaveLength(1);
    expect(w.sends.filter((s) => s.fn === "processPayouts")).toHaveLength(1);
    expect(r.memory.rescannedPayout).toBeUndefined();
    // another caller paid the batch out during the rescan: the flag goes with it
    const v = world();
    mismatched(v, [{ user: at("a1"), shares: TAO, assets: 2n * TAO }]);
    const s = await runs(v, 8, 12, (i) => {
      if (i === 2) {
        delete v.vault.batches[KEY_A.toLowerCase()];
        v.vault.pending = 0n;
      }
    });
    expect(s.end).toBeUndefined();
    expect(s.memory.rescannedPayout).toBeUndefined();
    // past its list check but waiting on its bridge fee, the batch still open: the flag goes too (a later mismatch is a
    // new one, rescanned afresh)
    const x = world();
    const xl = mismatched(x, [{ user: at("a1"), shares: TAO, assets: 2n * TAO }]);
    x.vault.payoutFee = 10n ** 18n;
    const u = await runs(x, 8, 12, (i) => {
      if (i === 1) x.vault.batches[KEY_A.toLowerCase()].payoutsHash = payoutsHash(xl);
    });
    expect(u.end).toBeUndefined();
    expect(x.vault.batches[KEY_A.toLowerCase()]).toBeDefined();
    expect(x.sends).toEqual([]);
    expect(u.lines.some((l) => l.includes("payout batch 0xabababab… waits: its bridge fee"))).toBe(true);
    expect(u.memory.rescannedPayout).toBeUndefined();
  });
});
