import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, type Hex, hexToBytes } from "viem";

/**
 * twox128("SubtensorModule") ++ twox128("BasketTwr"): the storage map holding each validator's
 * time-weighted return to its root stakers, net of the validator's take (U64F64, starts at 1.0).
 */
export const BASKET_TWR_PREFIX = "0x658faa385070e074c85bf6b568cf055520ccbf191cee8f588773f27f973f3186";
/** Bittensor's storage-query precompile: any SubtensorModule value, at any block an archive node keeps. */
export const STORAGE_QUERY = "0x0000000000000000000000000000000000000807";
/** 30 days of 12-second blocks. */
export const APY_WINDOW_BLOCKS = 216_000n;
/** The keeper claims and restakes rewards about once a month. */
const CLAIMS_PER_YEAR = 12;
/** Above this the figure is more likely a bad read than a real yield, so it is hidden. */
const APY_MAX_PERCENT = 20;
const YEAR_S = 365 * 86_400;

/** The BasketTwr key for a hotkey (Blake2_128Concat). */
export function basketTwrKey(hotkey: Hex): Hex {
  return `${BASKET_TWR_PREFIX}${bytesToHex(blake2b(hexToBytes(hotkey), { dkLen: 16 })).slice(2)}${hotkey.slice(2)}`;
}

/** U64F64 as stored: the raw bits of a u128, little-endian. Empty means the hotkey has no series. */
export function decodeTwr(data: Hex | undefined): bigint | null {
  if (!data || data === "0x") return null;
  return hexToBytes(data).reduceRight((v, b) => (v << 8n) | BigInt(b), 0n);
}

/**
 * Depositors' yield in TAO over the window, as a percent: the validator's return, annualized,
 * less Cascade's cut of rewards, compounded monthly. Undefined when it can't be stood behind.
 */
export function netApyPercent({
  twrNow,
  twrThen,
  seconds,
  rewardCutBps,
}: {
  twrNow: bigint | null;
  twrThen: bigint | null;
  seconds: number;
  rewardCutBps: number;
}): number | undefined {
  if (twrNow === null || twrThen === null || twrThen <= 0n || seconds <= 0) return undefined;
  const r = Number((twrNow * 10n ** 18n) / twrThen) / 1e18;
  if (r < 1) return undefined;
  const apr = (r - 1) * (YEAR_S / seconds) * (1 - rewardCutBps / 10_000);
  const apy = ((1 + apr / CLAIMS_PER_YEAR) ** CLAIMS_PER_YEAR - 1) * 100;
  return apy <= APY_MAX_PERCENT ? apy : undefined;
}
