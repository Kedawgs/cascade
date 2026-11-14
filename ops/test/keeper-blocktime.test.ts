import { encodeAbiParameters, encodeEventTopics, type Hex, numberToHex, padHex, parseAbiParameters } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { ChainName } from "../src/config.ts";
import { BLOCK_TIME_FRESH_MS, BLOCK_TIME_SPAN, blocksIn, blockTimeOf, MARGIN_FALLBACK_S, secondsPerBlock } from "../src/keeper/blocktime.ts";
import { blockAtOrAfter, KEEPER_READ_ABIS, marginsOf, REREAD_S, SETTLE_S, trackMessage } from "../src/keeper/state.ts";
import type { Rpc } from "../src/rpc.ts";
import { fakeChain, v3Record } from "./fake-keeper.ts";

// Base went from 2-second to 200 ms blocks at block 53,556,128 (2026-11-05 18:00 UTC). Every time the keeper turns into
// blocks reads the chain's block time from its headers (keeper/blocktime.ts), never a constant.

const TAO = 10n ** 18n;

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

describe("a chain's block time, from its headers", () => {
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

  it("refuses blocks with no time between them, keeping nothing, so a later read tries again", async () => {
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
    expect(blocksIn(1_800, 0.2)).toBe(9_000n);
    expect(blocksIn(60, 12)).toBe(5n);
  });
});

describe("the keeper's re-read and settle margins, in time", () => {
  it("re-read 140 s and settle 60 s of Base's blocks at its measured block time (700 and 300 of its 200 ms blocks), 4,800 s and 120 s of Bittensor's (400 and 10 of its 12 s)", async () => {
    expect(REREAD_S).toEqual({ base: 140, bittensor: 4_800 });
    expect(SETTLE_S).toEqual({ base: 60, bittensor: 120 });
    expect(await marginsOf(chain(0.2).rpc, "base")).toEqual({ reread: 700n, settle: 300n });
    // what they always were on Base's 2-second blocks
    expect(await marginsOf(chain(2).rpc, "base")).toEqual({ reread: 70n, settle: 30n });
    expect(await marginsOf(chain(12).rpc, "bittensor")).toEqual({ reread: 400n, settle: 10n });
  });

  it("are counted at the block times they were set at (Base's 2 s, Bittensor's 12 s) while a chain's own can't be read", async () => {
    const flat: Rpc = {
      async request(_c, _m, params) {
        const n = params[0] === "latest" ? 5_000n : BigInt(params[0] as Hex);
        return { number: numberToHex(n), timestamp: numberToHex(7) };
      },
    };
    expect(MARGIN_FALLBACK_S).toEqual({ base: 2, bittensor: 12 });
    expect(await marginsOf(flat, "base")).toEqual({ reread: 70n, settle: 30n });
    expect(await marginsOf(flat, "bittensor")).toEqual({ reread: 400n, settle: 10n });
  });
});

describe("the v3-launch keeper's searches at Base's 200 ms blocks", () => {
  it("the first block at or after a time: the guess at the measured block time lands on it (at 2 s a block it would land 27,000 blocks off)", async () => {
    // five blocks to a whole second, head 50,000 at 11,000 s
    const reads: bigint[] = [];
    const fast: Rpc = {
      async request(_c, method, params) {
        if (method !== "eth_getBlockByNumber") throw new Error(`unexpected ${method}`);
        reads.push(BigInt(params[0] as Hex));
        return { timestamp: numberToHex(1_000 + Math.floor(Number(BigInt(params[0] as Hex)) / 5)) };
      },
    };
    expect(await blockAtOrAfter(fast, "base", 5_000, 50_000n, 11_000)).toBe(20_000n);
    // two reads measure the block time (blocks 49,000 and 48,000), two check both sides of the guess
    expect(reads).toEqual([49_000n, 48_000n, 20_000n, 19_999n]);
  });

  it("the first block at or after a time is still found, from block 0 up, when the block time can't be read", async () => {
    // the newest 2,000 blocks all at one time: no block time, a bracket up from block 0 instead
    const odd: Rpc = {
      async request(_c, _m, params) {
        const n = BigInt(params[0] as Hex);
        return { timestamp: numberToHex(n >= 40n ? 2_000 : 1_000) };
      },
    };
    expect(await blockAtOrAfter(odd, "base", 1_500, 5_000n, 2_000)).toBe(40n);
  });

  it("trackMessage looks for a message it didn't send over Base's last half hour by time: a Sent 5,000 blocks (17 minutes) back is found", async () => {
    const rec = v3Record();
    const HEAD: Record<ChainName, number> = { base: 57_000_000, bittensor: 2_000 };
    const id: Hex = `0x${"5a".repeat(32)}`;
    const sentAt = HEAD.base - 5_000;
    const [topic0] = encodeEventTopics({ abi: KEEPER_READ_ABIS.ADAPTER, eventName: "Sent" } as never);
    const log = {
      address: rec.plan.addresses.baseAdapter,
      topics: [topic0, id, padHex(rec.plan.addresses.frontDoor, { size: 32 }), padHex(rec.plan.addresses.vault, { size: 32 })],
      data: encodeAbiParameters(parseAbiParameters("uint64, uint256, uint256, uint256"), [964n, TAO, 10n ** 15n, 500_000n]),
      blockNumber: numberToHex(sentAt),
      logIndex: "0x0",
      transactionHash: `0x${"77".repeat(32)}`,
    };
    const ranges: [number, number][] = [];
    const c = fakeChain([KEEPER_READ_ABIS.OFFRAMP], { getExecutionState: () => 2 }, {
      eth_blockNumber: (ch) => numberToHex(HEAD[ch]),
      // Base's 200 ms blocks (Bittensor's 12 s), the head at 1,800,000,000
      eth_getBlockByNumber: (ch, params) => {
        const n = params[0] === "latest" ? HEAD[ch] : Number(BigInt(params[0] as Hex));
        return { number: numberToHex(n), timestamp: numberToHex(1_800_000_000 - Math.floor((HEAD[ch] - n) * (ch === "base" ? 0.2 : 12))) };
      },
      eth_getLogs: (ch, params) => {
        const f = params[0] as { fromBlock: Hex; toBlock: Hex };
        const [from, to] = [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))];
        if (ch === "base") ranges.push([from, to]);
        return ch === "base" && from <= sentAt && sentAt <= to ? [log] : [];
      },
    });
    const ctx = { ...c.ctx, log: () => undefined, logsWindow: { base: 100_000n, bittensor: 1_000n } };
    expect(await trackMessage(ctx, rec, id, { pollMs: 0, maxMs: 0 })).toBe("SUCCESS");
    // half an hour of 200 ms blocks: 9,000 back (1,000 on the old 2-second count, which missed it)
    expect(ranges[0]).toEqual([HEAD.base - 9_000, HEAD.base]);
  });
});
