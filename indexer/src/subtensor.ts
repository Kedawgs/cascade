import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, type Hex, hexToBytes } from "viem";

/** Bittensor's staking precompile (getStake, getUnclaimedRootTaoByHotkey, …). */
export const STAKING_PRECOMPILE = "0x0000000000000000000000000000000000000805" as Hex;
/** Bittensor's storage-query precompile: an eth_call with a raw storage key answers the raw value (as the
 * site reads BasketTwr, web/src/lib/cascade/apy.ts). */
export const STORAGE_QUERY = "0x0000000000000000000000000000000000000807" as Hex;

/** twox128("SubtensorModule") ++ twox128("Owner"): the map of each hotkey's owning coldkey. Worked out
 * with xxhash64; the first half is the site's BasketTwr prefix's too. Checked against the live chain by
 * the smoke test. */
export const OWNER_PREFIX = "0x658faa385070e074c85bf6b568cf0555eca6b7a1fdc9f689184ecb4f359c0518" as Hex;

/** The `Owner` storage key for a hotkey: the prefix, then Blake2_128Concat (blake2b-128 of the key, then
 * the key). */
export function ownerStorageKey(hotkey: Hex): Hex {
  return `${OWNER_PREFIX}${bytesToHex(blake2b(hexToBytes(hotkey), { dkLen: 16 })).slice(2)}${hotkey.slice(2).toLowerCase()}` as Hex;
}

/** An AccountId32 as stored (32 bytes), lowercase; null for no entry (empty) or anything else. */
export function decodeAccountId(data: Hex | undefined): Hex | null {
  if (!data || data === "0x" || !/^0x[0-9a-fA-F]{64}$/.test(data)) return null;
  return data.toLowerCase() as Hex;
}
