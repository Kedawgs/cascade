import { blake2b } from "@noble/hashes/blake2";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { DEFERRED_BASKET_CASH_CLAIMED_PREFIX, DEFERRED_BASKET_DEBTS_PREFIX, SYSTEM_NUMBER_KEY } from "../abi.ts";
import { answersU32 } from "./hotkeys.ts";

// R6b (U9): a hotkey's deferred rewards, before a keeper's or the guardian's removeHotkey. The vault's dust check reads
// getUnclaimedRootTaoByHotkey, which leaves out a coldkey's deferred dividend entitlements: a stake move or a payout's walk
// that ran while the hotkey's queued credits couldn't settle snapshots the vault's share as a deferred entitlement, which
// survives the move (the review's confirmed Info, Fable's check of it). A claim pays it (claim_deferred_dividends), but
// once the hotkey is removed only a privileged re-listing can claim it. So before such a removal ops reads the vault
// coldkey's two deferred rows on the hotkey through the storage-query precompile, subtensor's own test of "an unstaked
// claimant still owed" (root_claim_hotkeys: a DeferredBasketDebts entry, or DeferredBasketCashClaimed below 0), and
// refuses while what they owe, with the view's unclaimed, is above the vault's dust allowance, or can't be read.

/** What Bittensor still owes the vault's coldkey on a hotkey it holds no stake on, beyond the unclaimed view: subnet alpha
 * (whole rao, as a claim would sell it; counted one for one against the TAO dust allowance, an upper bound while subnet
 * alpha trades under 1 TAO) and TAO from a dissolved origin's cash (rao). */
export interface DeferredOwed {
  alphaRao: bigint;
  cashRao: bigint;
}

/** Blake2_128Concat of a 32-byte key: blake2b-128 of it, then the key itself. */
const blake2_128Concat = (key: Hex): string => `${bytesToHex(blake2b(hexToBytes(key), { dkLen: 16 })).slice(2)}${key.slice(2).toLowerCase()}`;

export const deferredDebtsKey = (hotkey: Hex, coldkey: Hex): Hex => `${DEFERRED_BASKET_DEBTS_PREFIX}${blake2_128Concat(hotkey)}${blake2_128Concat(coldkey)}` as Hex;
export const deferredCashKey = (hotkey: Hex, coldkey: Hex): Hex => `${DEFERRED_BASKET_CASH_CLAIMED_PREFIX}${blake2_128Concat(hotkey)}${blake2_128Concat(coldkey)}` as Hex;

/** A little-endian unsigned integer from `b[i..i+n)`. */
const uint = (b: Uint8Array, i: number, n: number): bigint => {
  let x = 0n;
  for (let k = n - 1; k >= 0; k--) x = (x << 8n) | BigInt(b[i + k]);
  return x;
};
/** A little-endian two's-complement i128 from `b[i..i+16)`. */
const int128 = (b: Uint8Array, i: number): bigint => {
  const x = uint(b, i, 16);
  return x >= 1n << 127n ? x - (1n << 128n) : x;
};
const isHex = (data: unknown): data is Hex => typeof data === "string" && /^0x([0-9a-fA-F]{2})*$/.test(data);

/** The alpha (whole rao) a DeferredBasketDebts value says the coldkey is still owed with no stake on the hotkey: the sum,
 * over its origins, of the debt below 0 (an I64F64, rounded down as the chain's claim takes it); 0 for no entry ("0x");
 * undefined for anything that isn't a SCALE compact count of (u16 netuid, u64 generation, i128 amount) rows. */
export function decodeDebtsOwed(data: unknown): bigint | undefined {
  if (data === "0x") return 0n;
  if (!isHex(data)) return undefined;
  const b = hexToBytes(data);
  if (b.length === 0) return 0n;
  // SCALE compact: the low two bits say its width (the map holds at most 129 rows: one or two bytes)
  const mode = b[0] & 3;
  if (mode > 1) return undefined;
  const width = mode === 0 ? 1 : 2;
  if (b.length < width) return undefined;
  const n = Number(uint(b, 0, width) >> 2n);
  if (b.length !== width + n * 26) return undefined;
  let owed = 0n;
  for (let r = 0; r < n; r++) {
    const amount = int128(b, width + r * 26 + 10);
    if (amount < 0n) owed += -amount >> 64n;
  }
  return owed;
}

/** The TAO (rao) a DeferredBasketCashClaimed value says the coldkey is still owed with no stake on the hotkey: the
 * watermark below 0; 0 for no entry; undefined for anything that isn't 16 bytes. */
export function decodeCashOwed(data: unknown): bigint | undefined {
  if (data === "0x") return 0n;
  if (!isHex(data) || data.length !== 2 + 32) return undefined;
  const claimed = int128(hexToBytes(data), 0);
  return claimed < 0n ? -claimed : 0n;
}

/** Reads both rows for `hotkey` and the vault's `coldkey` through `ask` (the storage-query precompile: an eth_call whose
 * data is the raw key). An empty answer is believed only once the block number's key answers, since a chain with no code
 * at the precompile (an anvil fork) answers "0x" to everything; a refused read, or an answer that doesn't decode, is
 * unread, never "nothing owed". */
export async function readDeferred(ask: (key: Hex) => Promise<unknown>, hotkey: Hex, coldkey: Hex): Promise<DeferredOwed | { unread: string }> {
  try {
    if (!answersU32(await ask(SYSTEM_NUMBER_KEY))) return { unread: "the storage-query precompile answered nothing for the block number, a key that always has an entry" };
    const alphaRao = decodeDebtsOwed(await ask(deferredDebtsKey(hotkey, coldkey)));
    if (alphaRao === undefined) return { unread: "DeferredBasketDebts' answer doesn't decode" };
    const cashRao = decodeCashOwed(await ask(deferredCashKey(hotkey, coldkey)));
    if (cashRao === undefined) return { unread: "DeferredBasketCashClaimed's answer is not an i128" };
    return { alphaRao, cashRao };
  } catch (e) {
    return { unread: `the storage-query precompile refused it (${(e as Error).message.split("\n")[0]})` };
  }
}

const n = (x: bigint) => x.toLocaleString("en-US");

/** Why `hotkey` must not be removed by the keeper or the guardian now for its deferred rewards, or undefined: they can't be
 * read, or with the view's unclaimed (`unclaimedRao`) they are above the vault's dust allowance (`dustRao`, its
 * hotkeyDustRao), as the vault's own removal judges the view alone. */
export function deferredProblem(d: DeferredOwed | { unread: string } | undefined, dustRao: bigint, unclaimedRao: bigint, hotkey: Hex): string | undefined {
  if (d === undefined || "unread" in d) {
    return `the vault's deferred rewards on hotkey ${hotkey} can't be read now (${d?.unread ?? "not read"}): it is removed only once they read as paid`;
  }
  if (d.alphaRao + d.cashRao + unclaimedRao <= dustRao) return undefined;
  return `Bittensor still owes the vault deferred rewards on hotkey ${hotkey} (${n(d.alphaRao)} rao of subnet alpha and ${n(d.cashRao)} rao of TAO, which the unclaimed-rewards read leaves out), more than the ${n(dustRao)} rao dust allowance: a removal now would strand them. A claim pays them once they convert (its credits then show, and the keeper claims them); remove it after. To give them up instead, the owner's pnpm ops remove-hotkey ${hotkey} --as owner --forfeit --for-wallet --live`;
}
