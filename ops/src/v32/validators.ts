import { blake2b } from "@noble/hashes/blake2";
import { bytesToHex, formatUnits, type Hex, hexToBytes } from "viem";
import type { Env } from "../config.ts";
import { chainIdOf, type Rpc } from "../rpc.ts";
import type { Ctx } from "../send.ts";
import { encodeSs58 } from "../ss58.ts";
import { type V32Validators, validatorsFromEnv } from "./settings.ts";

// The validators as validators (spec §7 step 3: "the standby's take, root stake and uid read and printed"; ruling A8:
// a record-free `pnpm ops verify --validators` reads both hotkeys from configuration). Each is read from Bittensor's
// own storage through the storage-query precompile, as the indexer reads the stake hotkey (indexer/src/subtensor.ts,
// whose keys were checked against the live runtime's metadata on 2026-10-31; test/v32-validators.test.ts holds these to
// that file): its take (Delegates), its root stake (TotalHotkeyAlpha on netuid 0, in rao) and its root uid (Uids on
// netuid 0). What is read is printed, never compared: the founder judges a validator. A hotkey with no root uid is a
// warning (it is not a root validator), and a read that fails or does not decode is a failure.

/** Bittensor's storage-query precompile: an eth_call whose data is a raw storage key answers the raw SCALE value. */
export const STORAGE_QUERY = "0x0000000000000000000000000000000000000807" as Hex;

/** twox128("SubtensorModule") ++ twox128(item), each as indexer/src/subtensor.ts has it. */
export const SUBTENSOR_PREFIXES = {
  /** `Delegates`: MAP (hotkey) → take (u16, of 65,535), a ValueQuery whose default is 11,796 (18%). */
  Delegates: "0x658faa385070e074c85bf6b568cf055560d1f0ff648e4c86ea413fc0173d4038",
  /** `TotalHotkeyAlpha`: DMAP (hotkey Blake2_128Concat, netuid Identity) → u64, on root the rao staked on it by everyone. */
  TotalHotkeyAlpha: "0x658faa385070e074c85bf6b568cf0555ee25c3b5b1886863480497907f1829e6",
  /** `Uids`: DMAP (netuid Identity, hotkey Blake2_128Concat) → u16, no entry when it is not registered there. */
  Uids: "0x658faa385070e074c85bf6b568cf0555aab1b4e78e1ea8305462ee53b3686dc8",
} as const satisfies Record<string, Hex>;

/** The take a hotkey with no `Delegates` entry has (the entry's default bytes 0x142e in the live runtime's metadata). */
export const DEFAULT_TAKE = 11_796;
const TAKE_DENOMINATOR = 65_535;
const ROOT = 0;

/** Blake2_128Concat of a 32-byte key: blake2b-128 of it, then the key itself. */
const blake2_128Concat = (key: Hex): string => `${bytesToHex(blake2b(hexToBytes(key), { dkLen: 16 })).slice(2)}${key.slice(2).toLowerCase()}`;
/** A netuid as an `Identity` map key: its u16, little-endian. */
const netuidKey = (netuid: number): string => `${(netuid & 0xff).toString(16).padStart(2, "0")}${((netuid >> 8) & 0xff).toString(16).padStart(2, "0")}`;

export const delegatesKey = (hotkey: Hex): Hex => `${SUBTENSOR_PREFIXES.Delegates}${blake2_128Concat(hotkey)}` as Hex;
export const totalHotkeyAlphaKey = (hotkey: Hex, netuid: number): Hex => `${SUBTENSOR_PREFIXES.TotalHotkeyAlpha}${blake2_128Concat(hotkey)}${netuidKey(netuid)}` as Hex;
export const uidsKey = (netuid: number, hotkey: Hex): Hex => `${SUBTENSOR_PREFIXES.Uids}${netuidKey(netuid)}${blake2_128Concat(hotkey)}` as Hex;

/** A little-endian SCALE unsigned integer of `bytes` bytes as stored: null for no entry (empty), undefined for anything
 * that is not exactly that many bytes. */
function decodeUint(data: unknown, bytes: number): bigint | null | undefined {
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return undefined;
  if (data === "0x") return null;
  const b = hexToBytes(data as Hex);
  if (b.length !== bytes) return undefined;
  let x = 0n;
  for (let i = bytes - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
  return x;
}

/** One validator as Bittensor stores it: its take (of 65,535; `defaulted` when it has no entry of its own), its root
 * stake in rao, and its root uid (null when it is not registered on root). */
export interface ValidatorReading {
  hotkey: Hex;
  take: number;
  defaulted: boolean;
  rootStakeRao: bigint;
  rootUid: number | null;
}

/** Reads `hotkey`'s take, root stake and root uid. Throws, naming what, when a read fails or answers something that is
 * not the stored type. */
export async function readValidator(ctx: { rpc: Rpc }, hotkey: Hex): Promise<ValidatorReading> {
  const raw = async (what: string, key: Hex): Promise<unknown> => {
    try {
      return await ctx.rpc.request("bittensor", "eth_call", [{ to: STORAGE_QUERY, data: key }, "latest"]);
    } catch (e) {
      throw new Error(`its ${what} could not be read (${(e as Error).message.split("\n")[0]})`);
    }
  };
  const take = decodeUint(await raw("take", delegatesKey(hotkey)), 2);
  if (take === undefined) throw new Error("its take is not a stored u16");
  const stake = decodeUint(await raw("root stake", totalHotkeyAlphaKey(hotkey, ROOT)), 8);
  if (stake === undefined) throw new Error("its root stake is not a stored u64");
  const uid = decodeUint(await raw("root uid", uidsKey(ROOT, hotkey)), 2);
  if (uid === undefined) throw new Error("its root uid is not a stored u16");
  return { hotkey, take: take === null ? DEFAULT_TAKE : Number(take), defaulted: take === null, rootStakeRao: stake ?? 0n, rootUid: uid === null ? null : Number(uid) };
}

const percent = (take: number) => `${((take * 100) / TAKE_DENOMINATOR).toFixed(2)}%`;
const tao = (rao: bigint) => Number(formatUnits(rao, 9)).toLocaleString("en-US", { maximumFractionDigits: 9 });

/** What verify says of each validator: one line each (information), a warning for one not registered on root, a failure
 * for one that could not be read. */
export async function validatorFindings(ctx: { rpc: Rpc }, validators: V32Validators): Promise<{ failures: string[]; warnings: string[]; info: string[] }> {
  const out = { failures: [] as string[], warnings: [] as string[], info: [] as string[] };
  for (const [role, hotkey] of [
    ["primary", validators.primary],
    ["standby", validators.standby],
  ] as const) {
    const who = `Bittensor validator (the ${role}) ${encodeSs58(hotkey)}`;
    let v: ValidatorReading;
    try {
      v = await readValidator(ctx, hotkey);
    } catch (e) {
      out.failures.push(`${who}: ${(e as Error).message}`);
      continue;
    }
    const take = `take ${percent(v.take)} (${v.take.toLocaleString("en-US")} of 65,535${v.defaulted ? ", the chain's default" : ""})`;
    const uid = v.rootUid === null ? "no root uid" : `root uid ${v.rootUid}`;
    out.info.push(`${who}: ${take}, root stake ${tao(v.rootStakeRao)} TAO, ${uid}`);
    if (v.rootUid === null) out.warnings.push(`${who} has no uid on the root network: check it is still a root validator before staking with it`);
  }
  return out;
}

/** `pnpm ops verify --validators` (ruling A8): the two validators named in the configuration (OPS_V32_PRIMARY_HOTKEY and
 * OPS_V32_STANDBY_HOTKEY), each read on Bittensor and printed, before any deployment exists: it needs no record. Refused,
 * reading nothing, while either hotkey is missing or malformed, and when the RPC answers another chain's id. `ok` is
 * false when a read failed. */
export async function validatorsCommandV32(ctx: Pick<Ctx, "rpc" | "targets">, env: Env): Promise<{ lines: string[]; ok: boolean }> {
  const validators = validatorsFromEnv(env);
  const id = await chainIdOf(ctx.rpc, "bittensor");
  if (id !== ctx.targets.bittensor.chainId) throw new Error(`Bittensor: the RPC reports chain id ${id}, not ${ctx.targets.bittensor.chainId}; nothing read`);
  const f = await validatorFindings(ctx, validators);
  const lines = [...f.info];
  if (f.warnings.length) lines.push(`Warnings (not failures):\n  ${f.warnings.join("\n  ")}`);
  if (f.failures.length) lines.push(`FAILED:\n  ${f.failures.join("\n  ")}`);
  return { lines, ok: f.failures.length === 0 };
}
