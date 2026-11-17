import { blake2b } from "@noble/hashes/blake2";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { DEFERRED_BASKET_CASH_CLAIMED_PREFIX, DEFERRED_BASKET_DEBTS_PREFIX, ROOT_STAKE_UNLOCK_INTERVAL_KEY, SYSTEM_NUMBER_KEY } from "../src/keeper/core/abi.ts";
import { decodeCashOwed, decodeDebtsOwed, deferredCashKey, deferredDebtsKey, deferredProblem, readDeferred } from "../src/keeper/core/v32/deferred.ts";
import { SUBTENSOR_PREFIXES } from "../src/v32/validators.ts";

// R6b (U9): removeHotkey's dust check reads getUnclaimedRootTaoByHotkey, which leaves out a coldkey's deferred dividend
// entitlements (a move or a walk that ran while the hotkey's queued credits couldn't settle). Before a keeper or guardian
// removal, ops reads the vault coldkey's two deferred rows on the hotkey through the storage-query precompile
// (DeferredBasketDebts, DeferredBasketCashClaimed: subtensor's own rule for "an unstaked claimant still owed",
// root_claim_hotkeys) and refuses while they owe more than the dust allowance, or can't be read.

const HK: Hex = `0x${"5e".repeat(32)}`;
const COLD: Hex = `0x${"c0".repeat(32)}`;
const DUST = 1_000_000n;

/** xxhash64 (and Substrate's twox128 from it), to hold the two new prefixes to their items' names, the way the four ops
 * already used reproduce (validators.ts, abi.ts). */
const M = (1n << 64n) - 1n;
const [P1, P2, P3, P4, P5] = [0x9e3779b185ebca87n, 0xc2b2ae3d27d4eb4fn, 0x165667b19e3779f9n, 0x85ebca77c2b2ae63n, 0x27d4eb2f165667c5n];
const rotl = (x: bigint, r: number) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M;
const rd = (b: Uint8Array, i: number, n: number) => {
  let x = 0n;
  for (let k = n - 1; k >= 0; k--) x = (x << 8n) | BigInt(b[i + k]);
  return x;
};
const round = (acc: bigint, v: bigint) => (rotl((acc + v * P2) & M, 31) * P1) & M;
const merge = (acc: bigint, v: bigint) => ((((acc ^ round(0n, v)) * P1) & M) + P4) & M;
function xxh64(b: Uint8Array, seed: bigint): bigint {
  let i = 0;
  let h: bigint;
  if (b.length >= 32) {
    let [v1, v2, v3, v4] = [(seed + P1 + P2) & M, (seed + P2) & M, seed, (seed - P1) & M];
    for (; i + 32 <= b.length; i += 32) [v1, v2, v3, v4] = [round(v1, rd(b, i, 8)), round(v2, rd(b, i + 8, 8)), round(v3, rd(b, i + 16, 8)), round(v4, rd(b, i + 24, 8))];
    h = [v1, v2, v3, v4].reduce(merge, (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M);
  } else h = (seed + P5) & M;
  h = (h + BigInt(b.length)) & M;
  for (; i + 8 <= b.length; i += 8) h = (rotl(h ^ round(0n, rd(b, i, 8)), 27) * P1 + P4) & M;
  if (i + 4 <= b.length) (h = (rotl(h ^ ((rd(b, i, 4) * P1) & M), 23) * P2 + P3) & M), (i += 4);
  for (; i < b.length; i++) h = (rotl(h ^ ((BigInt(b[i]) * P5) & M), 11) * P1) & M;
  h ^= h >> 33n;
  h = (h * P2) & M;
  h ^= h >> 29n;
  h = (h * P3) & M;
  return h ^ (h >> 32n);
}
const le = (x: bigint) => Array.from({ length: 8 }, (_, k) => ((x >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0")).join("");
const twox128 = (s: string) => {
  const b = new TextEncoder().encode(s);
  return le(xxh64(b, 0n)) + le(xxh64(b, 1n));
};
const b2c = (k: Hex) => `${bytesToHex(blake2b(hexToBytes(k), { dkLen: 16 })).slice(2)}${k.slice(2)}`;

/** A SCALE i128, little-endian two's complement. */
const i128 = (x: bigint) => le(x & M) + le((x >> 64n) & M);
/** A DeferredBasketDebts value: compact length, then (u16 netuid, u64 generation, I64F64 amount as its i128 bits). */
function debts(rows: { netuid: number; amount: bigint }[]): Hex {
  const n = rows.length * 4; // compact u32 in single-byte mode: n << 2
  const u16 = (x: number) => `${(x & 0xff).toString(16).padStart(2, "0")}${((x >> 8) & 0xff).toString(16).padStart(2, "0")}`;
  return `0x${n.toString(16).padStart(2, "0")}${rows.map((r) => `${u16(r.netuid)}${le(7n)}${i128(r.amount)}`).join("")}` as Hex;
}
const ONE = 1n << 64n;

describe("R6b (U9): a hotkey's deferred rewards, before a keeper or guardian removal", () => {
  it("the two prefixes are twox128(SubtensorModule) ++ twox128 of their items, as the prefixes ops already uses reproduce", () => {
    // the method reproduces every prefix ops already holds, read against the live runtime's metadata on 2026-10-31
    expect(`0x${twox128("SubtensorModule")}${twox128("RootStakeUnlockInterval")}`).toBe(ROOT_STAKE_UNLOCK_INTERVAL_KEY);
    expect(`0x${twox128("System")}${twox128("Number")}`).toBe(SYSTEM_NUMBER_KEY);
    for (const [item, prefix] of Object.entries(SUBTENSOR_PREFIXES)) expect(`0x${twox128("SubtensorModule")}${twox128(item)}`, item).toBe(prefix);
    expect(DEFERRED_BASKET_DEBTS_PREFIX).toBe(`0x${twox128("SubtensorModule")}${twox128("DeferredBasketDebts")}`);
    expect(DEFERRED_BASKET_CASH_CLAIMED_PREFIX).toBe(`0x${twox128("SubtensorModule")}${twox128("DeferredBasketCashClaimed")}`);
    // both double maps: (hotkey Blake2_128Concat, coldkey Blake2_128Concat)
    expect(deferredDebtsKey(HK, COLD)).toBe(`${DEFERRED_BASKET_DEBTS_PREFIX}${b2c(HK)}${b2c(COLD)}`);
    expect(deferredCashKey(HK, COLD)).toBe(`${DEFERRED_BASKET_CASH_CLAIMED_PREFIX}${b2c(HK)}${b2c(COLD)}`);
  });

  it("decodes what the chain still owes an unstaked coldkey: a debt below 0 is alpha owed (whole rao, as a claim sells it), the cash watermark below 0 is TAO owed; no entry is nothing", () => {
    expect(decodeDebtsOwed("0x")).toBe(0n);
    // two origins: 2.5 alpha rao owed rounds down to 2; a debt at or above 0 owes nothing
    expect(decodeDebtsOwed(debts([{ netuid: 3, amount: -(5n * ONE) / 2n }, { netuid: 9, amount: 4n * ONE }]))).toBe(2n);
    expect(decodeDebtsOwed(debts([{ netuid: 3, amount: -(ONE / 2n) }]))).toBe(0n);
    expect(decodeDebtsOwed(debts([{ netuid: 3, amount: -(3_000_000n * ONE) }, { netuid: 4, amount: -(ONE * 7n) }]))).toBe(3_000_007n);
    // anything else doesn't decode: never read as nothing owed
    expect(decodeDebtsOwed(`${debts([{ netuid: 3, amount: -ONE }])}00` as Hex)).toBeUndefined();
    expect(decodeDebtsOwed("0x0c")).toBeUndefined();
    expect(decodeCashOwed("0x")).toBe(0n);
    expect(decodeCashOwed(`0x${i128(-2_000_000n)}`)).toBe(2_000_000n);
    expect(decodeCashOwed(`0x${i128(5n)}`)).toBe(0n);
    expect(decodeCashOwed("0x1234")).toBeUndefined();
  });

  it("reads both rows through the storage-query precompile, believing an empty answer only once the block number answers; refuses a removal while they owe more than the dust allowance or can't be read", async () => {
    const answers: Record<string, Hex> = { [SYSTEM_NUMBER_KEY.toLowerCase()]: "0x10270000" };
    const ask = async (key: Hex) => answers[key.toLowerCase()] ?? "0x";
    expect(await readDeferred(ask, HK, COLD)).toEqual({ alphaRao: 0n, cashRao: 0n });
    expect(deferredProblem({ alphaRao: 0n, cashRao: 0n }, DUST, 0n, HK)).toBeUndefined();
    answers[deferredDebtsKey(HK, COLD).toLowerCase()] = debts([{ netuid: 3, amount: -(600_000n * ONE) }]);
    answers[deferredCashKey(HK, COLD).toLowerCase()] = `0x${i128(-500_000n)}`;
    const owed = await readDeferred(ask, HK, COLD);
    expect(owed).toEqual({ alphaRao: 600_000n, cashRao: 500_000n });
    expect(deferredProblem(owed, DUST, 0n, HK)).toBe(
      `Bittensor still owes the vault deferred rewards on hotkey ${HK} (600,000 rao of subnet alpha and 500,000 rao of TAO, which the unclaimed-rewards read leaves out), more than the 1,000,000 rao dust allowance: a removal now would strand them. A claim pays them once they convert (its credits then show, and the keeper claims them); remove it after. To give them up instead, the owner's pnpm ops remove-hotkey ${HK} --as owner --forfeit --for-wallet --live`,
    );
    // within the dust allowance, the view's unclaimed counted with them: no refusal; past it by a rao: refused
    expect(deferredProblem({ alphaRao: 400_000n, cashRao: 500_000n }, DUST, 100_000n, HK)).toBeUndefined();
    expect(deferredProblem({ alphaRao: 400_000n, cashRao: 500_000n }, DUST, 100_001n, HK)).toMatch(/^Bittensor still owes the vault deferred rewards/);
    // a precompile that answers nothing for the block number (no code there: an anvil fork) or a refused read: unread
    const none = await readDeferred(async () => "0x", HK, COLD);
    expect(none).toEqual({ unread: "the storage-query precompile answered nothing for the block number, a key that always has an entry" });
    expect(await readDeferred(async () => Promise.reject(new Error("execution reverted")), HK, COLD)).toEqual({ unread: "the storage-query precompile refused it (execution reverted)" });
    expect(deferredProblem(none, DUST, 0n, HK)).toBe(
      `the vault's deferred rewards on hotkey ${HK} can't be read now (the storage-query precompile answered nothing for the block number, a key that always has an entry): it is removed only once they read as paid`,
    );
    answers[deferredCashKey(HK, COLD).toLowerCase()] = "0x1234";
    expect(await readDeferred(ask, HK, COLD)).toEqual({ unread: "DeferredBasketCashClaimed's answer is not an i128" });
  });
});
