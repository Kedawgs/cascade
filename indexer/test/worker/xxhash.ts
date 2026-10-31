// xxHash64 and Substrate's twox128, for tests only: the storage-key prefixes in src/subtensor.ts and src/apy.ts are
// constants worked out offline, and these tests work them out again from the storage items' names.

const M = (1n << 64n) - 1n;
const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;

const rotl = (x: bigint, r: number) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M;
const read64 = (b: Uint8Array, i: number) => {
  let x = 0n;
  for (let k = 7; k >= 0; k--) x = (x << 8n) | BigInt(b[i + k]);
  return x;
};
const read32 = (b: Uint8Array, i: number) => BigInt(b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + (BigInt(b[i + 3]) << 24n);
const round = (acc: bigint, lane: bigint) => (rotl((acc + lane * P2) & M, 31) * P1) & M;
const merge = (acc: bigint, v: bigint) => ((acc ^ round(0n, v)) * P1 + P4) & M;

/** xxHash64 of `b` with `seed`. */
export function xxh64(b: Uint8Array, seed: bigint): bigint {
  const n = b.length;
  let i = 0;
  let h: bigint;
  if (n >= 32) {
    let v1 = (seed + P1 + P2) & M;
    let v2 = (seed + P2) & M;
    let v3 = seed;
    let v4 = (seed - P1) & M;
    for (; i + 32 <= n; i += 32) {
      v1 = round(v1, read64(b, i));
      v2 = round(v2, read64(b, i + 8));
      v3 = round(v3, read64(b, i + 16));
      v4 = round(v4, read64(b, i + 24));
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M;
    for (const v of [v1, v2, v3, v4]) h = merge(h, v);
  } else {
    h = (seed + P5) & M;
  }
  h = (h + BigInt(n)) & M;
  for (; i + 8 <= n; i += 8) {
    h ^= round(0n, read64(b, i));
    h = (rotl(h, 27) * P1 + P4) & M;
  }
  if (i + 4 <= n) {
    h ^= (read32(b, i) * P1) & M;
    h = (rotl(h, 23) * P2 + P3) & M;
    i += 4;
  }
  for (; i < n; i++) {
    h ^= (BigInt(b[i]) * P5) & M;
    h = (rotl(h, 11) * P1) & M;
  }
  h ^= h >> 33n;
  h = (h * P2) & M;
  h ^= h >> 29n;
  h = (h * P3) & M;
  h ^= h >> 32n;
  return h;
}

const le = (x: bigint) => Array.from({ length: 8 }, (_, k) => ((x >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0")).join("");

/** Substrate's twox128 of a name, as hex without 0x: xxHash64 seeds 0 and 1, each little-endian. */
export const twox128 = (s: string): string => {
  const b = new TextEncoder().encode(s);
  return le(xxh64(b, 0n)) + le(xxh64(b, 1n));
};
