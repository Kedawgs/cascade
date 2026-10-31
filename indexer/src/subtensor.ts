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

/** twox128("SubtensorModule") ++ twox128("StakingHotkeys"): the map of the hotkeys each coldkey has stake on
 * (Blake2_128Concat(coldkey) → Vec<AccountId32>), kept by add_stake, remove_stake, move_stake and the hotkey
 * swap. twox128("StakingHotkeys") was worked out with an xxhash64 that reproduces OWNER_PREFIX's two halves
 * and the BasketTwr prefix (src/apy.ts). The smoke test checks the live chain answers it with a list that
 * holds the stake hotkey. */
export const STAKING_HOTKEYS_PREFIX = "0x658faa385070e074c85bf6b568cf0555b7d32a0408ab25b30dac6ec2cb66fe1f" as Hex;

/** The `StakingHotkeys` storage key for a coldkey: the prefix, then Blake2_128Concat (blake2b-128 of the
 * key, then the key). */
export function stakingHotkeysKey(coldkey: Hex): Hex {
  return `${STAKING_HOTKEYS_PREFIX}${bytesToHex(blake2b(hexToBytes(coldkey), { dkLen: 16 })).slice(2)}${coldkey.slice(2).toLowerCase()}` as Hex;
}

/** A SCALE `Vec<AccountId32>` as stored: a compact length, then 32 bytes an id; lowercase. `[]` for no entry
 * (empty: a coldkey with no stake anywhere), null for anything that doesn't decode as such a list. */
export function decodeAccountIds(data: Hex | undefined): Hex[] | null {
  if (!data || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return null;
  if (data === "0x") return [];
  const bytes = hexToBytes(data);
  // the compact length: its low two bits say how many bytes it takes
  const mode = bytes[0] & 3;
  let n: number;
  let at: number;
  if (mode === 0) {
    n = bytes[0] >> 2;
    at = 1;
  } else if (mode === 1 && bytes.length >= 2) {
    n = (bytes[0] | (bytes[1] << 8)) >> 2;
    at = 2;
  } else if (mode === 2 && bytes.length >= 4) {
    n = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 2;
    at = 4;
  } else {
    return null;
  }
  if (bytes.length !== at + 32 * n) return null;
  const out: Hex[] = [];
  for (let i = 0; i < n; i++) out.push(bytesToHex(bytes.subarray(at + 32 * i, at + 32 * (i + 1))).toLowerCase() as Hex);
  return out;
}
