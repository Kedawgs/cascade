import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { BASKET_TWR_PREFIX } from "../../src/apy.ts";
import {
  DELEGATES_PREFIX,
  decodeU16,
  decodeU64,
  delegatesKey,
  OWNER_PREFIX,
  ROOT_STAKE_UNLOCK_INTERVAL_KEY,
  STAKING_HOTKEYS_PREFIX,
  TOTAL_HOTKEY_ALPHA_PREFIX,
  totalHotkeyAlphaKey,
  UIDS_PREFIX,
  uidsKey,
} from "../../src/subtensor.ts";
import { twox128 } from "./xxhash.ts";

const HOTKEY = "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748" as Hex;
/** blake2b-128 of HOTKEY (the ownerStorageKey test's, from CPython's hashlib) */
const HOTKEY_BLAKE = "6c1664b37fae67165907bd92805ee938";
const prefix = (item: string) => `0x${twox128("SubtensorModule")}${twox128(item)}`;

describe("SubtensorModule storage keys, worked out again from the items' names", () => {
  it("the xxhash reproduces the known prefixes (System, and the ones already in use)", () => {
    expect(twox128("System")).toBe("26aa394eea5630e07c48ae0c9558cef7");
    expect(prefix("Owner")).toBe(OWNER_PREFIX);
    expect(prefix("StakingHotkeys")).toBe(STAKING_HOTKEYS_PREFIX);
    expect(prefix("BasketTwr")).toBe(BASKET_TWR_PREFIX);
  });

  it("Delegates(hotkey): the prefix, then Blake2_128Concat(hotkey)", () => {
    expect(DELEGATES_PREFIX).toBe(prefix("Delegates"));
    expect(delegatesKey(HOTKEY)).toBe(`${prefix("Delegates")}${HOTKEY_BLAKE}${HOTKEY.slice(2)}`);
  });

  it("TotalHotkeyAlpha(hotkey, netuid): Blake2_128Concat(hotkey), then the netuid as it is (u16, little-endian)", () => {
    expect(TOTAL_HOTKEY_ALPHA_PREFIX).toBe(prefix("TotalHotkeyAlpha"));
    expect(totalHotkeyAlphaKey(HOTKEY, 0)).toBe(`${prefix("TotalHotkeyAlpha")}${HOTKEY_BLAKE}${HOTKEY.slice(2)}0000`);
    expect(totalHotkeyAlphaKey(HOTKEY, 0x0102).endsWith("0201")).toBe(true);
  });

  it("Uids(netuid, hotkey): the netuid as it is first, then Blake2_128Concat(hotkey)", () => {
    expect(UIDS_PREFIX).toBe(prefix("Uids"));
    expect(uidsKey(0, HOTKEY)).toBe(`${prefix("Uids")}0000${HOTKEY_BLAKE}${HOTKEY.slice(2)}`);
  });

  it("RootStakeUnlockInterval: a plain value, its prefix alone", () => {
    expect(ROOT_STAKE_UNLOCK_INTERVAL_KEY).toBe(prefix("RootStakeUnlockInterval"));
  });
});

describe("decoding SCALE integers as the storage query answers them", () => {
  it("reads the values the live chain answered for the launch's validator (2026-10-31)", () => {
    // Delegates: take 0 (of 65,535); TotalHotkeyAlpha on root: 1,021,436.95 TAO; Uids on root: uid 1;
    // RootStakeUnlockInterval: unset (empty: the default 0, no hold)
    expect(decodeU16("0x0000")).toBe(0);
    expect(decodeU64("0x8a54d1d2fda00300")).toBe(1_021_436_954_236_042n);
    expect(decodeU16("0x0100")).toBe(1);
    expect(decodeU64("0x")).toBeNull();
  });

  it("is little-endian, says no entry for empty storage, and refuses any other length or non-hex", () => {
    expect(decodeU16("0xffff")).toBe(65_535);
    expect(decodeU16("0x0d2e")).toBe(0x2e0d);
    expect(decodeU16("0x")).toBeNull();
    expect(decodeU16(undefined)).toBeUndefined();
    expect(decodeU16("0x00")).toBeUndefined();
    expect(decodeU16("0x000000")).toBeUndefined();
    expect(decodeU16("0xzzzz")).toBeUndefined();
    expect(decodeU64("0x0100000000000000")).toBe(1n);
    expect(decodeU64("0xffffffffffffffff")).toBe(2n ** 64n - 1n);
    expect(decodeU64("0x01000000")).toBeUndefined();
    expect(decodeU64(`0x${"00".repeat(32)}`)).toBeUndefined();
  });
});
