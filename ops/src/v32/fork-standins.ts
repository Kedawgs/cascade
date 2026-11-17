import { type Address, bytesToHex, concat, encodeAbiParameters, getAddress, type Hex, keccak256, numberToHex, pad, parseAbiParameters, stringToBytes, toFunctionSelector } from "viem";
import { PRECOMPILE } from "../config.ts";
import type { Rpc } from "../rpc.ts";
import { addressMapping } from "./plan.ts";

// v3.2's stand-ins for Bittensor's precompiles on a local anvil fork (Task 61; ruling A9), which has none (the live
// chain's precompile addresses hold no code: an eth_call to one on a fork answers nothing). contracts/test/rehearsal's
// RehearsalPrecompiles (v3-launch's) covers the stake, the unstake and the transfer; v3.2 needs three things more, and
// contracts/ is not this track's to change, so they are here, as three small programs installed with anvil_setCode:
// - the address mapping answers a table (blake2b-256("evm:" ++ address), which plan.ts derives, written per address by
//   the rehearsal), falling back to v3-launch's zero-padded address, because the v3.2 vault's constructor and its lens
//   check the real mapping (ColdkeyMismatch);
// - the staking precompile is a front for RehearsalStaking (installed at STAKING_IMPL and reached by DELEGATECALL, so its
//   stakes and aliases stay at the precompile's address) that answers three more functions itself: the reject flag's
//   setter and getter (the vault's constructor sets it; verify reads it), and getTotalColdkeyStakeOnSubnet, summed over
//   the hotkeys the rehearsal lists; moveStake and claimRootWithHotkey remain unanswered (they revert), as they did;
// - the storage-query precompile replays answers read from the live chain beforehand (verify's validator lines read the
//   take, the root stake and the root uid through it), keyed by the raw storage key.
// Nothing here runs on a real chain.

/** Where RehearsalStaking's code runs behind the staking front: an address no one holds. */
export const STAKING_IMPL: Address = "0x00000000000000000000000000000000c0ffee05";
/** Bittensor's storage-query precompile. */
export const STORAGE_QUERY: Address = "0x0000000000000000000000000000000000000807";

/** A tag word, the second half of each stand-in mapping's key (keccak256(key ++ tag)), far from Solidity's own slots. */
const tag = (name: string): Hex => keccak256(stringToBytes(`cascade v3.2 rehearsal: ${name}`));
export const REJECT_TAG = tag("reject staking hotkey growth");
/** The hotkeys getTotalColdkeyStakeOnSubnet sums: the count at this slot, the hotkeys from the next one on. */
export const HOTKEYS_SLOT = tag("hotkeys");

// ---- a small assembler ----

const OPS: Record<string, number> = {
  STOP: 0x00,
  ADD: 0x01,
  SUB: 0x03,
  LT: 0x10,
  GT: 0x11,
  EQ: 0x14,
  ISZERO: 0x15,
  SHR: 0x1c,
  SHA3: 0x20,
  CALLER: 0x33,
  CALLDATALOAD: 0x35,
  CALLDATASIZE: 0x36,
  CALLDATACOPY: 0x37,
  RETURNDATASIZE: 0x3d,
  RETURNDATACOPY: 0x3e,
  POP: 0x50,
  MSTORE: 0x52,
  SLOAD: 0x54,
  SSTORE: 0x55,
  JUMP: 0x56,
  JUMPI: 0x57,
  GAS: 0x5a,
  JUMPDEST: 0x5b,
  DUP1: 0x80,
  SWAP1: 0x90,
  SWAP2: 0x91,
  RETURN: 0xf3,
  DELEGATECALL: 0xf4,
  REVERT: 0xfd,
};

/** One instruction: an opcode by name; a push of a number or of bytes (its width from the value, or `width`); a label;
 * or a push of a label's offset (two bytes). */
export type Asm = string | { push: bigint | number | Hex; width?: number } | { label: string } | { pushLabel: string };

/** The bytecode of `program`: each label's offset is where its JUMPDEST sits (the label itself is a JUMPDEST). */
export function assemble(program: readonly Asm[]): Hex {
  const sizeOf = (i: Asm): number => {
    if (typeof i === "string") return 1;
    if ("label" in i) return 1;
    if ("pushLabel" in i) return 3;
    return 1 + pushBytes(i).length;
  };
  const labels = new Map<string, number>();
  let at = 0;
  for (const i of program) {
    if (typeof i === "object" && "label" in i) {
      if (labels.has(i.label)) throw new Error(`label ${i.label} twice`);
      labels.set(i.label, at);
    }
    at += sizeOf(i);
  }
  const out: number[] = [];
  for (const i of program) {
    if (typeof i === "string") {
      const op = OPS[i];
      if (op === undefined) throw new Error(`no opcode ${i}`);
      out.push(op);
    } else if ("label" in i) out.push(OPS.JUMPDEST);
    else if ("pushLabel" in i) {
      const to = labels.get(i.pushLabel);
      if (to === undefined) throw new Error(`no label ${i.pushLabel}`);
      out.push(0x61, to >> 8, to & 0xff);
    } else {
      const b = pushBytes(i);
      out.push(0x5f + b.length, ...b);
    }
  }
  return bytesToHex(new Uint8Array(out));
}

function pushBytes(i: { push: bigint | number | Hex; width?: number }): number[] {
  let hex: string;
  if (typeof i.push === "string") hex = i.push.slice(2);
  else {
    const v = BigInt(i.push);
    if (v < 0n) throw new Error("a push is never negative");
    hex = v.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
  }
  if (i.width !== undefined) hex = hex.padStart(i.width * 2, "0");
  const n = hex.length / 2;
  if (n < 1 || n > 32) throw new Error(`a push of ${n} bytes`);
  return Array.from({ length: n }, (_, k) => Number.parseInt(hex.slice(2 * k, 2 * k + 2), 16));
}

const ret32: Asm[] = [{ push: 0 }, "MSTORE", { push: 32 }, { push: 0 }, "RETURN"];

/** The address mapping: storage[keccak256(word)] for the address word in the calldata, or the word itself (v3-launch's
 * zero-padded answer) when the table has none. */
export const ADDRESS_MAPPING_PROGRAM: Asm[] = [
  { push: 4 },
  "CALLDATALOAD",
  "DUP1",
  { push: 0 },
  "MSTORE",
  { push: 32 },
  { push: 0 },
  "SHA3",
  "SLOAD",
  "DUP1",
  { pushLabel: "found" },
  "JUMPI",
  "POP",
  ...ret32,
  { label: "found" },
  ...ret32,
];

/** The staking front: three functions answered here, everything else run as RehearsalStaking's code (DELEGATECALL), its
 * return data or revert passed back. */
export function stakingProgram(impl: Address = STAKING_IMPL): Asm[] {
  const sel = (sig: string) => ({ push: toFunctionSelector(sig) as Hex });
  const keyed = (second: Asm[]): Asm[] => [{ push: 0 }, "MSTORE", ...second, { push: 32 }, "MSTORE", { push: 64 }, { push: 0 }, "SHA3"];
  return [
    { push: 0 },
    "CALLDATALOAD",
    { push: 0xe0 },
    "SHR",
    "DUP1",
    sel("getRejectStakingHotkeyGrowth(bytes32)"),
    "EQ",
    { pushLabel: "get" },
    "JUMPI",
    "DUP1",
    sel("setRejectStakingHotkeyGrowth(bool)"),
    "EQ",
    { pushLabel: "set" },
    "JUMPI",
    "DUP1",
    sel("getTotalColdkeyStakeOnSubnet(bytes32,uint256)"),
    "EQ",
    { pushLabel: "total" },
    "JUMPI",
    "POP",
    // RehearsalStaking's code, with this address's storage and balance
    "CALLDATASIZE",
    { push: 0 },
    { push: 0 },
    "CALLDATACOPY",
    { push: 0 },
    { push: 0 },
    "CALLDATASIZE",
    { push: 0 },
    { push: getAddress(impl) as Hex },
    "GAS",
    "DELEGATECALL",
    "RETURNDATASIZE",
    { push: 0 },
    { push: 0 },
    "RETURNDATACOPY",
    { pushLabel: "ok" },
    "JUMPI",
    "RETURNDATASIZE",
    { push: 0 },
    "REVERT",
    { label: "ok" },
    "RETURNDATASIZE",
    { push: 0 },
    "RETURN",
    // getRejectStakingHotkeyGrowth(coldkey): storage[keccak256(coldkey ++ REJECT_TAG)]
    { label: "get" },
    "POP",
    { push: 4 },
    "CALLDATALOAD",
    ...keyed([{ push: REJECT_TAG }]),
    "SLOAD",
    ...ret32,
    // setRejectStakingHotkeyGrowth(flag): under the caller's coldkey, RehearsalStaking's alias for it (coldkeyAlias, its
    // slot 1) or else its zero-padded address, as RehearsalStaking's _cold
    { label: "set" },
    "POP",
    "CALLER",
    ...keyed([{ push: 1 }]),
    "SLOAD",
    "DUP1",
    { pushLabel: "aliased" },
    "JUMPI",
    "POP",
    "CALLER",
    { label: "aliased" },
    { push: 4 },
    "CALLDATALOAD",
    "SWAP1",
    ...keyed([{ push: REJECT_TAG }]),
    "SSTORE",
    "STOP",
    // getTotalColdkeyStakeOnSubnet(coldkey, netuid): the sum of RehearsalStaking's _stake[h][coldkey][netuid] (its slot 0)
    // over the listed hotkeys h
    { label: "total" },
    "POP",
    { push: 0 },
    { push: 0 },
    { label: "loop" },
    "DUP1",
    { push: HOTKEYS_SLOT },
    "SLOAD",
    "GT",
    "ISZERO",
    { pushLabel: "done" },
    "JUMPI",
    "DUP1",
    { push: BigInt(HOTKEYS_SLOT) + 1n, width: 32 },
    "ADD",
    "SLOAD",
    ...keyed([{ push: 0 }]),
    { push: 32 },
    "MSTORE",
    { push: 4 },
    "CALLDATALOAD",
    { push: 0 },
    "MSTORE",
    { push: 64 },
    { push: 0 },
    "SHA3",
    { push: 32 },
    "MSTORE",
    { push: 0x24 },
    "CALLDATALOAD",
    { push: 0 },
    "MSTORE",
    { push: 64 },
    { push: 0 },
    "SHA3",
    "SLOAD",
    "SWAP1",
    "SWAP2",
    "ADD",
    "SWAP1",
    { push: 1 },
    "ADD",
    { pushLabel: "loop" },
    "JUMP",
    { label: "done" },
    "POP",
    ...ret32,
  ];
}

/** The storage-query replay: for the raw key in the calldata, the bytes recorded under keccak256(key): their length
 * plus one at that slot (0: no entry, an empty answer), the bytes left-aligned in the next. */
export const STORAGE_QUERY_PROGRAM: Asm[] = [
  "CALLDATASIZE",
  { push: 0 },
  { push: 0 },
  "CALLDATACOPY",
  "CALLDATASIZE",
  { push: 0 },
  "SHA3",
  "DUP1",
  "SLOAD",
  "DUP1",
  "ISZERO",
  { pushLabel: "empty" },
  "JUMPI",
  { push: 1 },
  "SWAP1",
  "SUB",
  "SWAP1",
  { push: 1 },
  "ADD",
  "SLOAD",
  { push: 0 },
  "MSTORE",
  { push: 0 },
  "RETURN",
  { label: "empty" },
  { push: 0 },
  { push: 0 },
  "RETURN",
];

// ---- their storage ----

const word = (x: bigint | Hex): Hex => (typeof x === "bigint" ? pad(numberToHex(x), { size: 32 }) : pad(x, { size: 32 }));
/** Solidity's slot of `mapping[key]` for a mapping at `slot` (or a stand-in's tag word). */
export const mappingSlot = (key: Hex, slot: bigint | Hex): Hex => keccak256(concat([word(key), word(slot)]));
const addressWord = (a: Address): Hex => encodeAbiParameters(parseAbiParameters("address"), [getAddress(a)]);

/** The address mapping's table entry for `address`: its slot, and the coldkey the chain derives for it. */
export const mappingEntry = (address: Address): { slot: Hex; value: Hex } => ({ slot: keccak256(addressWord(address)), value: addressMapping(address) });

/** RehearsalStaking's coldkeyAlias[who] (its slot 1). */
export const aliasSlot = (who: Address): Hex => mappingSlot(addressWord(who), 1n);

/** RehearsalStaking's _stake[hotkey][coldkey][netuid] (its slot 0). */
export const stakeSlot = (hotkey: Hex, coldkey: Hex, netuid: bigint): Hex => mappingSlot(word(netuid), mappingSlot(coldkey, mappingSlot(hotkey, 0n)));

/** The reject flag of `coldkey`, as the staking front keeps it. */
export const rejectSlot = (coldkey: Hex): Hex => mappingSlot(coldkey, REJECT_TAG);

/** The storage-query replay's two slots for `key`: its length plus one, and its bytes left-aligned. */
export function replaySlots(key: Hex, answer: Hex): { slot: Hex; value: Hex }[] {
  const n = (answer.length - 2) / 2;
  if (n > 32) throw new Error(`a recorded answer of ${n} bytes (at most 32)`);
  const h = keccak256(key);
  return [
    { slot: h, value: word(BigInt(n + 1)) },
    { slot: numberToHex(BigInt(h) + 1n, { size: 32 }), value: `0x${answer.slice(2).padEnd(64, "0")}` as Hex },
  ];
}

const setStorage = (rpc: Rpc, at: Address, slot: Hex, value: Hex) => rpc.request("bittensor", "anvil_setStorageAt", [at, slot, word(value)]);

/** Installs the three v3.2 stand-ins on the Bittensor fork, over v3-launch's (startForks installs those): RehearsalStaking's
 * runtime (`stakingRuntime`) moves behind the staking front. */
export async function installStandInsV32(rpc: Rpc, stakingRuntime: Hex): Promise<void> {
  await rpc.request("bittensor", "anvil_setCode", [STAKING_IMPL, stakingRuntime]);
  await rpc.request("bittensor", "anvil_setCode", [PRECOMPILE.staking, assemble(stakingProgram())]);
  await rpc.request("bittensor", "anvil_setCode", [PRECOMPILE.addressMapping, assemble(ADDRESS_MAPPING_PROGRAM)]);
  await rpc.request("bittensor", "anvil_setCode", [STORAGE_QUERY, assemble(STORAGE_QUERY_PROGRAM)]);
}

/** A planned vault's place in the stand-ins, before its CREATE: the mapping answers its real coldkey, and the staking
 * stand-in books its stakes and its reject flag under it (an alias). */
export async function mapVault(rpc: Rpc, vault: Address): Promise<Hex> {
  const e = mappingEntry(vault);
  await setStorage(rpc, PRECOMPILE.addressMapping, e.slot, e.value);
  await setStorage(rpc, PRECOMPILE.staking, aliasSlot(vault), e.value);
  return e.value;
}

/** The hotkeys getTotalColdkeyStakeOnSubnet sums (the vault's listed ones). */
export async function listHotkeys(rpc: Rpc, hotkeys: readonly Hex[]): Promise<void> {
  await setStorage(rpc, PRECOMPILE.staking, HOTKEYS_SLOT, word(BigInt(hotkeys.length)));
  for (const [i, h] of hotkeys.entries()) await setStorage(rpc, PRECOMPILE.staking, numberToHex(BigInt(HOTKEYS_SLOT) + 1n + BigInt(i), { size: 32 }), h);
}

/** Records the live chain's answer to each storage key, read beforehand with `live`, for the replay. */
export async function replayStorage(rpc: Rpc, live: Rpc, keys: readonly Hex[]): Promise<Record<Hex, Hex>> {
  const out: Record<Hex, Hex> = {};
  for (const key of keys) {
    const answer = (await live.request("bittensor", "eth_call", [{ to: STORAGE_QUERY, data: key }, "latest"])) as Hex;
    out[key] = answer;
    for (const s of replaySlots(key, answer)) await setStorage(rpc, STORAGE_QUERY, s.slot, s.value);
  }
  return out;
}
