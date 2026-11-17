import { encodeAbiParameters, encodeEventTopics, type Hex, numberToHex, padHex, parseAbiParameters } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ADAPTER, OFFRAMP } from "../src/keeper/core/abi.ts";
import { BLOCK_TIME_FRESH_MS, BLOCK_TIME_SPAN, blocksIn, blockTimeOf, MARGIN_FALLBACK_S, secondsPerBlock } from "../src/keeper/core/blocktime.ts";
import { marginsOf, REREAD_S, SETTLE_S } from "../src/keeper/core/logs.ts";
import { freshMemory } from "../src/keeper/core/memory.ts";
import type { Rpc } from "../src/keeper/core/rpc.ts";
import { rootHoldWords } from "../src/keeper/core/v32/hotkeys.ts";
import { SENT_RETAIN_S } from "../src/keeper/core/v32/reads.ts";
import { trackMessage } from "../src/keeper/state.ts";
import { FAKE_HEAD, fakeChain, v3Record } from "./fake-keeper.ts";
import { ADDR, depsFor, failInWorld, laneMessage, sendInWorld, T, TAO, world } from "./keeper-v32-world.ts";

// Base went from 2-second to 200 ms blocks at block 53,556,128 (2026-11-05 18:00 UTC). Every time the keeper turns into
// blocks reads the chain's block time from two of its headers (blocktime.ts), never a constant.

/** A chain whose block n is at 1,000 + n × `s` seconds, whole seconds as a header gives them; head `head`. */
function chain(s: number, head = 100_000) {
  const reads: (bigint | "latest")[] = [];
  const rpc: Rpc = {
    async request(_c, method, params) {
      if (method !== "eth_getBlockByNumber") throw new Error(`unexpected ${method}`);
      const n = params[0] === "latest" ? BigInt(head) : BigInt(params[0] as Hex);
      reads.push(params[0] === "latest" ? "latest" : n);
      return { number: numberToHex(n), timestamp: numberToHex(1_000 + Math.floor(Number(n) * s)) };
    },
  };
  return { rpc, reads };
}

describe("a chain's block time, from two headers", () => {
  it("is the faster of two spans of BLOCK_TIME_SPAN blocks back from the head, by their times: Base's 0.2 s, its old 2 s, Bittensor's 12 s", async () => {
    expect(BLOCK_TIME_SPAN).toEqual({ base: 1_000n, bittensor: 300n });
    const base = chain(0.2);
    expect(await blockTimeOf(base.rpc, "base")).toBe(0.2);
    expect(base.reads).toEqual(["latest", 99_000n, 98_000n]);
    expect(await blockTimeOf(chain(2).rpc, "base")).toBe(2);
    const bit = chain(12);
    expect(await blockTimeOf(bit.rpc, "bittensor")).toBe(12);
    expect(bit.reads).toEqual(["latest", 99_700n, 99_400n]);
  });

  it("is never read slow by a halt or an outage in one span: the faster span stands", async () => {
    // Base's sequencer stopped for 10 minutes inside the newest 1,000 blocks
    const out: Rpc = {
      async request(_c, _m, params) {
        const n = params[0] === "latest" ? 100_000n : BigInt(params[0] as Hex);
        return { number: numberToHex(n), timestamp: numberToHex(1_000 + Math.floor(Number(n) * 0.2) + (n > 99_500n ? 600 : 0)) };
      },
    };
    expect(await blockTimeOf(out, "base")).toBe(0.2);
  });

  it("is read once for each RPC (a run's, a command's), from the head a caller gives; a younger chain from block 0", async () => {
    const base = chain(0.2);
    expect(await blockTimeOf(base.rpc, "base", { block: 100_000n, time: 21_000 })).toBe(0.2);
    expect(await blockTimeOf(base.rpc, "base")).toBe(0.2);
    expect(base.reads).toEqual([99_000n, 98_000n]);
    const young = chain(2, 500);
    expect(await blockTimeOf(young.rpc, "base")).toBe(2);
    expect(young.reads).toEqual(["latest", 0n]);
  });

  it("is read again after an hour, so a keeper left running follows a change of block time", async () => {
    let s = 0.2;
    const reads: (bigint | "latest")[] = [];
    const rpc: Rpc = {
      async request(_c, _m, params) {
        const n = params[0] === "latest" ? 100_000n : BigInt(params[0] as Hex);
        reads.push(params[0] === "latest" ? "latest" : n);
        return { number: numberToHex(n), timestamp: numberToHex(1_000 + Math.floor(Number(n) * s)) };
      },
    };
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      expect(BLOCK_TIME_FRESH_MS).toBe(3_600_000);
      expect(await blockTimeOf(rpc, "base")).toBe(0.2);
      s = 0.4;
      now.mockReturnValue(1_800_000_000_000 + BLOCK_TIME_FRESH_MS - 1);
      expect(await blockTimeOf(rpc, "base")).toBe(0.2);
      expect(reads).toHaveLength(3);
      now.mockReturnValue(1_800_000_000_000 + BLOCK_TIME_FRESH_MS);
      expect(await blockTimeOf(rpc, "base")).toBe(0.4);
      expect(reads).toHaveLength(6);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps the last block time read when a refresh fails, and tries again on the next call", async () => {
    let down = false;
    let reads = 0;
    const rpc: Rpc = {
      async request(_c, _m, params) {
        reads++;
        if (down) throw new Error("node down");
        const n = params[0] === "latest" ? 100_000n : BigInt(params[0] as Hex);
        return { number: numberToHex(n), timestamp: numberToHex(1_000 + Math.floor(Number(n) * 0.2)) };
      },
    };
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      expect(await blockTimeOf(rpc, "base")).toBe(0.2);
      down = true;
      now.mockReturnValue(1_800_000_000_000 + BLOCK_TIME_FRESH_MS);
      expect(await blockTimeOf(rpc, "base")).toBe(0.2);
      const after = reads;
      // not kept as fresh: the next call reads again
      expect(await blockTimeOf(rpc, "base")).toBe(0.2);
      expect(reads).toBeGreaterThan(after);
    } finally {
      now.mockRestore();
    }
  });

  it("the scans' re-read and settle margins are time, counted at the measured block time: 700 and 300 of Base's 200 ms blocks; at Base's 0.2 s and Bittensor's 12 s while never measured", async () => {
    expect(REREAD_S).toEqual({ base: 140, bittensor: 4_800 });
    expect(SETTLE_S).toEqual({ base: 60, bittensor: 120 });
    // never measured: Base's block time since block 53,556,128 and Bittensor's, erring high on blocks (review Minor 1)
    expect(MARGIN_FALLBACK_S).toEqual({ base: 0.2, bittensor: 12 });
    expect(await marginsOf(chain(0.2).rpc, "base")).toEqual({ reread: 700n, settle: 300n });
    expect(await marginsOf(chain(2).rpc, "base")).toEqual({ reread: 70n, settle: 30n });
    expect(await marginsOf(chain(12).rpc, "bittensor")).toEqual({ reread: 400n, settle: 10n });
    // Bittensor at 6 s a block: twice the blocks, the same time
    expect(await marginsOf(chain(6).rpc, "bittensor")).toEqual({ reread: 800n, settle: 20n });
    // unread (a node down): the block times they were set at, never a throw
    const down: Rpc = {
      async request() {
        throw new Error("node down");
      },
    };
    expect(await marginsOf(down, "base")).toEqual({ reread: 700n, settle: 300n });
    expect(await marginsOf(down, "bittensor")).toEqual({ reread: 400n, settle: 10n });
  });

  it("refuses a span with no time in it, keeping nothing, so a later read tries again", async () => {
    let flat = true;
    const rpc: Rpc = {
      async request(_c, _m, params) {
        const n = params[0] === "latest" ? 5_000n : BigInt(params[0] as Hex);
        return { number: numberToHex(n), timestamp: numberToHex(flat ? 7 : 1_000 + Number(n)) };
      },
    };
    await expect(blockTimeOf(rpc, "base")).rejects.toThrow(/Base's block time can't be read: its blocks up to 5000 are not apart in time/);
    flat = false;
    expect(await blockTimeOf(rpc, "base")).toBe(1);
    expect(secondsPerBlock({ block: 5n, time: 10 }, { block: 5n, time: 20 })).toBeUndefined();
    expect(blocksIn(86_400, 0.2)).toBe(432_000n);
    expect(blocksIn(60, 12)).toBe(5n);
  });
});

describe("the keeper's look-backs at Base's 200 ms blocks", () => {
  it("Cascade's sends are kept 15 days by time: a send two days old (864,000 blocks of 200 ms) is still in the index", async () => {
    const w = world();
    w.blockS.base = 0.2;
    w.head.base = 2_000_000n;
    const p = { recipient: ADDR.vault, sender: ADDR.frontDoor };
    const msg = laneMessage("Base → Bittensor", { ...p, message: "0x01" }, { amount: TAO, number: 1n });
    sendInWorld(w, "Base → Bittensor", msg, p, { block: w.head.base - 864_000n });
    expect(SENT_RETAIN_S).toBe(15 * 86_400);
    const sent = await depsFor(w, freshMemory(), undefined, () => undefined, { logsWindow: { base: 1_000_000n } }).deps.cascadeSent();
    expect(sent.map((x) => x.id)).toEqual([msg.id]);
    // 16 days of them on, it is let go
    const later = world();
    later.blockS.base = 0.2;
    later.head.base = 8_000_000n;
    sendInWorld(later, "Base → Bittensor", msg, p, { block: later.head.base - 16n * 432_000n });
    expect(await depsFor(later, freshMemory(), undefined, () => undefined, { logsWindow: { base: 10_000_000n } }).deps.cascadeSent()).toEqual([]);
  });

  it("a send looked up by its id near a time searches the blocks of that time: 20 days back is 8,640,000 of Base's blocks now, not 864,000", async () => {
    const w = world();
    w.blockS.base = 0.2;
    w.head.base = 20_000_000n;
    const p = { recipient: ADDR.vault, sender: ADDR.frontDoor };
    const msg = laneMessage("Base → Bittensor", { ...p, message: "0x02" }, { amount: TAO, number: 2n });
    const block = w.head.base - 20n * 432_000n;
    sendInWorld(w, "Base → Bittensor", msg, p, { block });
    const { deps } = depsFor(w, freshMemory(), undefined, () => undefined, { logsWindow: { base: 10_000_000n } });
    const found = await deps.sentById(msg.id, { direction: "Base → Bittensor", before: T - 20 * 86_400 + 1_800, lookbackS: 7 * 86_400 });
    expect(found).toMatchObject({ found: { id: msg.id.toLowerCase(), block } });
    // one bounded range, about 27 days back to 20 days back less an hour and a half, by Base's block time
    const q = w.logQueries.filter((x) => x.topics[0]?.toLowerCase() === `0x${msg.id.slice(2).toLowerCase().padStart(64, "0")}`);
    expect(q.map((x) => [x.from, x.to])).toEqual([[w.head.base - 11_673_000n, w.head.base - 8_613_000n]]);
  });

  it("a FAILURE is looked for from its message's own send time, read from its block's header (a Base send 10 hours ago: Bittensor's last 13 hours or so)", async () => {
    const w = world();
    w.blockS.base = 0.2;
    w.head.base = 1_000_000n;
    const p = { recipient: ADDR.vault, sender: ADDR.frontDoor };
    const msg = laneMessage("Base → Bittensor", { ...p, message: "0x03" }, { amount: TAO, number: 3n });
    const sentBlock = w.head.base - 180_000n;
    sendInWorld(w, "Base → Bittensor", msg, p, { block: sentBlock });
    w.blockTimes[`base:${sentBlock}`] = T - 36_000;
    failInWorld(w, "Base → Bittensor", msg, { block: w.head.bittensor - 10n });
    const { deps } = depsFor(w, freshMemory(), undefined, () => undefined, { logsWindow: { bittensor: 1_000n } });
    expect(await deps.failureOf("Base → Bittensor", msg.id, sentBlock)).toMatchObject({ found: { block: w.head.bittensor - 10n } });
    // from an hour, and a tenth of its age, before it was sent: 36,000 + 3,600 + 3,600 s of Bittensor's 12 s blocks
    const q = w.logQueries.filter((x) => x.chain === "bittensor" && x.address.toLowerCase() === ADDR.offRampBittensor.toLowerCase());
    expect(q[0].from).toBe(w.head.bittensor - 3_600n);
  });

  it("the root hold is told in time at Bittensor's block time, measured; in blocks alone when that is unread", () => {
    expect(rootHoldWords(7_200n, 12)).toBe("Bittensor holds root stake 7200 blocks (about 24 hours) after each add, remove or claim on a hotkey (RootStakeUnlockInterval)");
    expect(rootHoldWords(7_200n, 6)).toBe("Bittensor holds root stake 7200 blocks (about 12 hours) after each add, remove or claim on a hotkey (RootStakeUnlockInterval)");
    expect(rootHoldWords(7_200n)).toBe("Bittensor holds root stake 7200 blocks after each add, remove or claim on a hotkey (RootStakeUnlockInterval)");
  });
});

describe("v3-launch's trackMessage at Base's 200 ms blocks", () => {
  it("looks for a message it didn't send over Base's last half hour by time: a Sent 5,000 blocks (17 minutes) back is found", async () => {
    const rec = v3Record();
    const id: Hex = `0x${"5a".repeat(32)}`;
    const sentAt = FAKE_HEAD.base - 5_000;
    const [topic0] = encodeEventTopics({ abi: ADAPTER, eventName: "Sent" } as never);
    const log = {
      address: rec.plan.addresses.baseAdapter,
      topics: [topic0, id, padHex(rec.plan.addresses.frontDoor, { size: 32 }), padHex(rec.plan.addresses.vault, { size: 32 })],
      data: encodeAbiParameters(parseAbiParameters("uint64, uint256, uint256, uint256"), [964n, TAO, 10n ** 15n, 500_000n]),
      blockNumber: numberToHex(sentAt),
      logIndex: "0x0",
      transactionHash: `0x${"77".repeat(32)}`,
    };
    const ranges: [number, number][] = [];
    const c = fakeChain([OFFRAMP], { getExecutionState: () => 2 }, {
      eth_blockNumber: (chain) => numberToHex(FAKE_HEAD[chain]),
      eth_getLogs: (chain, params) => {
        const f = params[0] as { fromBlock: Hex; toBlock: Hex };
        const [from, to] = [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))];
        if (chain === "base") ranges.push([from, to]);
        return chain === "base" && from <= sentAt && sentAt <= to ? [log] : [];
      },
    });
    const ctx = { ...c.ctx, log: () => undefined, logsWindow: { base: 100_000n, bittensor: 1_000n } };
    expect(await trackMessage(ctx, rec, id, { pollMs: 0, maxMs: 0 })).toBe("SUCCESS");
    // half an hour of 200 ms blocks: 9,000 back
    expect(ranges[0]).toEqual([FAKE_HEAD.base - 9_000, FAKE_HEAD.base]);
  });
});
