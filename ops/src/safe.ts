import { type Address, encodeFunctionData, type Hex, keccak256, parseAbi, stringToBytes } from "viem";
import type { ChainName } from "./config.ts";
import { codeAt, read } from "./rpc.ts";
import type { Ctx } from "./send.ts";

/** One call for a Safe (or a timelock behind one) to make. */
export interface SafeCall {
  to: Address;
  value?: bigint;
  data: Hex;
  /** What it does, for the batch's description. */
  description: string;
}

/** A Safe{Wallet} Transaction Builder batch file, as the tx-builder app's own BatchFile type has it
 * (safe-global/safe-react-apps, apps/tx-builder/src/typings/models.ts): `version`, `chainId` (a string),
 * `createdAt` (ms), `meta` and `transactions`. Each transaction is raw: `to`, `value` (wei, a string) and
 * `data`, with no `contractMethod`, so the app sends exactly these bytes (it shows them as custom data). */
export interface SafeBatchFile {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: { name: string; description: string; createdFromSafeAddress?: string; checksum?: string };
  transactions: { to: string; value: string; data: string }[];
}

/** The tx-builder's checksum serialization (apps/tx-builder/src/lib/checksum.ts, serializeJSONObject):
 * an array is its elements' serializations joined by commas in brackets; an object is "{", its sorted key
 * list as JSON, each value's serialization followed by a comma, then "}"; anything else is its JSON, with
 * undefined as null. Not JSON itself, only a stable string to hash. */
export function checksumSerialize(json: unknown): string {
  const replacer = (_k: string, v: unknown) => (v === undefined ? null : v);
  if (Array.isArray(json)) return `[${json.map((el) => checksumSerialize(el)).join(",")}]`;
  if (typeof json === "object" && json !== null) {
    const keys = Object.keys(json).sort();
    let acc = `{${JSON.stringify(keys, replacer)}`;
    for (const k of keys) acc += `${checksumSerialize((json as Record<string, unknown>)[k])},`;
    return `${acc}}`;
  }
  return `${JSON.stringify(json, replacer)}`;
}

/** The checksum the tx-builder stores in meta.checksum and checks on import (otherwise it says the batch
 * was changed): keccak256 of the serialized file with meta.name as null and without the checksum itself. */
export function safeChecksum(file: SafeBatchFile): Hex {
  const { checksum: _, ...meta } = file.meta;
  return keccak256(stringToBytes(checksumSerialize({ ...file, meta: { ...meta, name: null } })));
}

/** A batch for the Safe at `safe` (when known) on `chainId`, checksummed. */
export function safeBatch(o: { chainId: number; name: string; calls: SafeCall[]; createdAt: number; safe?: Address }): SafeBatchFile {
  const file: SafeBatchFile = {
    version: "1.0",
    chainId: String(o.chainId),
    createdAt: o.createdAt,
    meta: {
      name: o.name,
      description: o.calls.map((c, i) => `${i + 1}. ${c.description}`).join("\n"),
      // only when known: a key with no value would be checksummed as null but dropped from the file
      ...(o.safe ? { createdFromSafeAddress: o.safe } : {}),
    },
    transactions: o.calls.map((c) => ({ to: c.to, value: (c.value ?? 0n).toString(), data: c.data })),
  };
  return { ...file, meta: { ...file.meta, checksum: safeChecksum(file) } };
}

/** OpenZeppelin's TimelockController: what a Safe calls to have the timelock make calls. */
export const TIMELOCK_ABI = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
]);

/** A Safe answers getThreshold; nothing else here is asked of it. */
export const SAFE_PROBE_ABI = parseAbi(["function getThreshold() view returns (uint256)"]);

const NO_PREDECESSOR: Hex = `0x${"00".repeat(32)}`;

/** `calls` made by the timelock at `timelock`: its proposer schedules them in one batch with `delay` (the
 * timelock's minimum), and once that has passed its executor runs them. The same `salt` in both. */
export function timelockCalls(timelock: Address, calls: SafeCall[], salt: Hex, delay: bigint): { schedule: SafeCall; execute: SafeCall } {
  const targets = calls.map((c) => c.to);
  const values = calls.map((c) => c.value ?? 0n);
  const payloads = calls.map((c) => c.data);
  const what = calls.map((c) => c.description).join("; ");
  return {
    schedule: {
      to: timelock,
      data: encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "scheduleBatch", args: [targets, values, payloads, NO_PREDECESSOR, salt, delay] }),
      description: `schedule on the timelock ${timelock}, ${delay} s delay: ${what}`,
    },
    execute: {
      to: timelock,
      data: encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "executeBatch", args: [targets, values, payloads, NO_PREDECESSOR, salt] }),
      description: `execute on the timelock ${timelock}: ${what}`,
    },
  };
}

export type AccountKind = { kind: "account" } | { kind: "safe" } | { kind: "timelock"; minDelay: bigint } | { kind: "contract" };

/** What signs for an owner or guardian: a plain account (no code: it sends its own transactions), an
 * OpenZeppelin timelock (answers getMinDelay), a Safe (answers getThreshold), or another contract. A probe
 * that fails, for any reason, counts as "not that kind". */
export async function accountKind(ctx: Pick<Ctx, "rpc">, chain: ChainName, address: Address): Promise<AccountKind> {
  if ((await codeAt(ctx.rpc, chain, address)) === "0x") return { kind: "account" };
  try {
    return { kind: "timelock", minDelay: (await read(ctx.rpc, chain, { address, abi: TIMELOCK_ABI, functionName: "getMinDelay" })) as bigint };
  } catch {
    // not a timelock
  }
  try {
    await read(ctx.rpc, chain, { address, abi: SAFE_PROBE_ABI, functionName: "getThreshold" });
    return { kind: "safe" };
  } catch {
    return { kind: "contract" };
  }
}
