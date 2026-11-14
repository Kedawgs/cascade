import type { PublicClient } from "viem";

// Each chain's block time, measured from two of its block headers, never assumed: Base went from 2-second blocks to
// 200 ms ones at block 53,556,128 (2026-11-05 18:00 UTC), so a count of blocks that meant five minutes before means
// thirty seconds after. Every search that turns a time into blocks reads it here, so a later change of either chain's
// block time needs no change of code.

/** How far apart the two headers are, in blocks: about 200 s of Base's and an hour of Bittensor's today, so whole-second
 * timestamps give the block time to within one percent. */
export const BLOCK_SPAN = { base: 1_000n, bittensor: 300n } as const;

/** A measure is read again after this long (a page left open for days follows a change). */
const FRESH_FOR_MS = 3_600_000;

type Tip = { number: bigint; timestamp: bigint };
const measured = new WeakMap<object, { at: number; ms: Promise<number> }>();

/** The milliseconds a block on `client`'s chain now: the faster of two spans of `span` blocks back from its tip (`tip`, when
 * already read), the newest and the one before it (from block 0 on a younger chain); read once a client, again after an
 * hour. The faster, because a halt or a sequencer outage in one span reads it slow, and a time counted back in blocks at
 * a slow reading lands after the block a search must start at or before. Throws, keeping nothing, when a header can't
 * be read or neither span is apart in time. */
export function blockMsOf(client: Pick<PublicClient, "getBlock">, span: bigint, tip?: Tip): Promise<number> {
  const known = measured.get(client);
  if (known && Date.now() - known.at < FRESH_FOR_MS) return known.ms;
  const ms = (async () => {
    const rate = (older: Tip, newer: Tip) => {
      const blocks = Number(newer.number - older.number);
      const elapsed = (Number(newer.timestamp) - Number(older.timestamp)) * 1000;
      return blocks > 0 && elapsed > 0 ? elapsed / blocks : undefined;
    };
    const newer = tip ?? (await client.getBlock({ blockTag: "latest" }));
    const mid = await client.getBlock({ blockNumber: newer.number > span ? newer.number - span : 0n });
    const recent = rate(mid, newer);
    const before = mid.number > 0n ? rate(await client.getBlock({ blockNumber: mid.number > span ? mid.number - span : 0n }), mid) : undefined;
    const ms = recent === undefined ? before : before === undefined ? recent : Math.min(recent, before);
    if (ms === undefined) throw new Error("the chain's block time can't be read: its blocks are not apart in time");
    return ms;
  })();
  measured.set(client, { at: Date.now(), ms });
  ms.catch(() => measured.delete(client));
  return ms;
}

/** The blocks `ms` of time take at `blockMs` a block, rounded up. */
export const blocksIn = (ms: number, blockMs: number): bigint => BigInt(Math.ceil(ms / blockMs));
