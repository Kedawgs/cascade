/** A fake client's getBlock for Base: block `head` at `nowS`, each earlier block `blockS` seconds before the next (whole
 * seconds, as a header gives them): 2 s, as these tests were written, or 0.2 s, Base's since block 53,556,128. */
export const baseHeaders =
  (head: bigint, nowS = 1_800_000_000, blockS = 2) =>
  async (q?: { blockTag?: string; blockNumber?: bigint }) => {
    const n = q?.blockNumber ?? head;
    return { number: n, timestamp: BigInt(nowS - Math.floor(Number(head - n) * blockS)) };
  };
