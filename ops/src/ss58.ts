import { createHash } from "node:crypto";
import type { Hex } from "viem";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BITTENSOR_PREFIX = 42;

function base58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`"${c}" is not a valid character in an SS58 address`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** The 32-byte public key in a Bittensor (prefix 42) SS58 address, after checking its checksum. */
export function decodeSs58(address: string): Hex {
  const raw = base58(address.trim());
  if (raw.length !== 35) throw new Error(`an SS58 address for one account decodes to 35 bytes, this one has the wrong length (${raw.length})`);
  const [prefix, key, check] = [raw[0], raw.subarray(1, 33), raw.subarray(33)];
  const hash = createHash("blake2b512").update(Buffer.from("SS58PRE")).update(raw.subarray(0, 33)).digest();
  if (hash[0] !== check[0] || hash[1] !== check[1]) throw new Error("the SS58 checksum does not match: a character is wrong");
  if (prefix !== BITTENSOR_PREFIX) throw new Error(`this address is for network prefix ${prefix}, not Bittensor's ${BITTENSOR_PREFIX}`);
  return `0x${Buffer.from(key).toString("hex")}`;
}
