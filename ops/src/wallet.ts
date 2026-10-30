import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, decodeFunctionData, encodeFunctionData, getAddress, type Hex, isAddress, isHex, parseAbi, toFunctionSelector, zeroAddress } from "viem";

/** The call file `--for-wallet` writes and `pnpm ops sign` serves: calls for a plain account (an owner
 * or guardian on a Ledger, through MetaMask) to send, one per click, from a page on this computer. */
export const WALLET_FILE_FORMAT = "cascade-wallet-calls";

/** The chains the signing page sends on. Nothing else: a call file for the local forks is refused. */
export const WALLET_CHAINS: Record<number, { name: string; short: string; symbol: string }> = {
  8453: { name: "Base", short: "Base", symbol: "ETH" },
  964: { name: "Bittensor EVM", short: "Bittensor", symbol: "TAO" },
};

/** Base refuses a transaction above this much gas (EIP-7825); no call here needs more. */
const MAX_GAS = 16_777_216;
const MAX_CALLS = 20;

/** Every function the page will send, with its parameters' names to show. Anything else is refused. */
export const KNOWN_ABI = parseAbi([
  "function acceptOwnership()",
  "function transferOwnership(address newOwner)",
  "function pause()",
  "function unpause()",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
]);
export type KnownFunction = (typeof KNOWN_ABI)[number]["name"];

export interface WalletCall {
  chainId: number;
  to: Address;
  data: Hex;
  /** Wei, in decimal: always "0", since none of the known functions takes value. */
  value: string;
  /** A gas limit to send with, in decimal: the cardinality steps, which a wallet padding its own
   * estimate could push over Base's cap. Otherwise the wallet estimates. */
  gas?: string;
  /** What it does, e.g. "acceptOwnership() on the vault". */
  label: string;
  /** The account that must send it: the page refuses any other. */
  from: Address;
  /** Who that is, e.g. "the owner". */
  sender: string;
}

export interface WalletFile {
  format: typeof WALLET_FILE_FORMAT;
  version: 1;
  title: string;
  /** ms */
  createdAt: number;
  /** The deployment whose record names the contracts called; absent when only the oracle's pools are. */
  deployment?: string;
  /** Each call waits for the one before it to succeed (the cardinality steps). */
  ordered: boolean;
  calls: WalletCall[];
}

export type NewWalletCall = Omit<WalletCall, "value" | "gas"> & { gas?: number | bigint };

/** A call file. Refuses a chain the page doesn't send on (the local forks among them). */
export function walletFile(o: { title: string; deployment?: string; ordered?: boolean; now: number; calls: NewWalletCall[] }): WalletFile {
  for (const c of o.calls) {
    if (!WALLET_CHAINS[c.chainId]) {
      throw new Error(`the wallet page sends only on Base (8453) and Bittensor EVM (964), not chain ${c.chainId}: prepare the calls against the live deployment`);
    }
  }
  return {
    format: WALLET_FILE_FORMAT,
    version: 1,
    title: o.title,
    createdAt: o.now,
    ...(o.deployment ? { deployment: o.deployment } : {}),
    ordered: o.ordered ?? false,
    calls: o.calls.map(({ gas, ...c }) => ({ ...c, value: "0", ...(gas !== undefined ? { gas: gas.toString() } : {}) })),
  };
}

/** Writes `file` as <dir>/<stem>.json and returns its path. */
export function writeWalletFile(dir: string, stem: string, file: WalletFile): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stem}.json`);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

/** The line a command prints once it has written a call file. */
export const wroteLine = (path: string, n: number) => `Wrote ${path} (${n} call${n === 1 ? "" : "s"}): send them from MetaMask with: pnpm ops sign ${path}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);

/** A call file read from disk, checked field by field: anything malformed is refused, not repaired. */
export function parseWalletFile(raw: unknown): WalletFile {
  if (!isRecord(raw) || raw.format !== WALLET_FILE_FORMAT) throw new Error(`not a call file (its format isn't "${WALLET_FILE_FORMAT}"): make one with --for-wallet`);
  if (raw.version !== 1) throw new Error(`call file version ${String(raw.version)}: this tool reads version 1`);
  if (!text(raw.title, 200)) throw new Error("the call file's title is missing or too long");
  if (typeof raw.createdAt !== "number" || !Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0) throw new Error("the call file's createdAt is not a time in ms");
  if (raw.deployment !== undefined && (typeof raw.deployment !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.deployment))) {
    throw new Error("the call file's deployment is not a plain name (e.g. v3-launch)");
  }
  if (typeof raw.ordered !== "boolean") throw new Error("the call file's ordered is not true or false");
  if (!Array.isArray(raw.calls) || raw.calls.length === 0) throw new Error("the call file has no calls");
  if (raw.calls.length > MAX_CALLS) throw new Error(`the call file has ${raw.calls.length} calls: at most ${MAX_CALLS}`);
  const calls = raw.calls.map((c: unknown, i: number): WalletCall => {
    const bad = (what: string) => new Error(`call ${i + 1}: ${what}`);
    if (!isRecord(c)) throw bad("is not an object");
    if (typeof c.chainId !== "number" || !WALLET_CHAINS[c.chainId]) throw bad(`chainId ${String(c.chainId)} is neither Base (8453) nor Bittensor EVM (964)`);
    if (typeof c.to !== "string" || !isAddress(c.to)) throw bad(`to ${String(c.to)} is not an address (or its checksum is wrong)`);
    if (typeof c.from !== "string" || !isAddress(c.from) || c.from.toLowerCase() === zeroAddress) throw bad(`from ${String(c.from)} is not an address (or its checksum is wrong)`);
    if (typeof c.data !== "string" || !isHex(c.data, { strict: true }) || c.data.length < 10 || c.data.length % 2 !== 0) throw bad("data is not calldata (0x and whole bytes)");
    if (c.value !== "0") throw bad("value must be 0: none of the known functions takes value");
    if (c.gas !== undefined && (typeof c.gas !== "string" || !/^[1-9]\d{0,7}$/.test(c.gas) || Number(c.gas) > MAX_GAS)) {
      throw bad(`gas ${String(c.gas)} is not a gas limit up to ${MAX_GAS.toLocaleString("en-US")}`);
    }
    if (!text(c.label, 200)) throw bad("label is missing or too long");
    if (!text(c.sender, 100)) throw bad("sender is missing or too long");
    return {
      chainId: c.chainId,
      to: c.to as Address,
      data: c.data as Hex,
      value: "0",
      ...(c.gas !== undefined ? { gas: c.gas as string } : {}),
      label: c.label as string,
      from: c.from as Address,
      sender: c.sender as string,
    };
  });
  return {
    format: WALLET_FILE_FORMAT,
    version: 1,
    title: raw.title as string,
    createdAt: raw.createdAt,
    ...(raw.deployment !== undefined ? { deployment: raw.deployment as string } : {}),
    ordered: raw.ordered,
    calls,
  };
}

export interface DecodedCall {
  name: KnownFunction;
  /** e.g. increaseObservationCardinalityNext(uint16) */
  signature: string;
  args: { name: string; type: string; value: string }[];
}

/** `data`'s function from KNOWN_ABI and its arguments, as text. Refuses an unknown selector, and
 * calldata that isn't exactly the standard encoding of what it decodes to (extra bytes, a value outside
 * its type), since a contract could read such bytes differently from what is shown. */
export function decodeKnownCall(data: Hex): DecodedCall {
  const selector = data.slice(0, 10).toLowerCase();
  const fn = KNOWN_ABI.find((f) => toFunctionSelector(f) === selector);
  if (!fn) throw new Error(`calldata ${selector || "0x"} is not one of the known functions (${KNOWN_ABI.map((f) => `${f.name}()`).join(", ")})`);
  let args: readonly unknown[];
  try {
    args = decodeFunctionData({ abi: [fn], data }).args ?? [];
  } catch (e) {
    throw new Error(`calldata for ${fn.name} doesn't decode: ${(e as Error).message.split("\n")[0]}`);
  }
  let again: Hex;
  try {
    again = encodeFunctionData({ abi: [fn], functionName: fn.name, args } as never);
  } catch {
    again = "0x";
  }
  if (again.toLowerCase() !== data.toLowerCase()) throw new Error(`calldata for ${fn.name} is not the exact encoding of its arguments (extra bytes, or a value out of its type's range)`);
  return {
    name: fn.name,
    signature: `${fn.name}(${fn.inputs.map((p) => p.type).join(",")})`,
    args: fn.inputs.map((p, i) => ({ name: p.name ?? `arg${i}`, type: p.type, value: p.type === "address" ? getAddress(args[i] as string) : String(args[i]) })),
  };
}

/** A contract the page may call: its role ("Vault"), chain and the functions this tool calls on it. */
export interface KnownContract {
  chainId: number;
  address: Address;
  name: string;
  functions: readonly KnownFunction[];
}

export interface CallView extends WalletCall {
  /** "Bittensor EVM" */
  network: string;
  /** "Vault on Bittensor" */
  contract: string;
  fn: DecodedCall;
  /** "0 TAO" */
  valueText: string;
}

export interface WalletView extends Omit<WalletFile, "calls"> {
  calls: CallView[];
}

/** Each call checked against `known`: its `to` must be a known contract on its chain, and its function
 * one this tool calls on that contract. What the page shows comes from here, not from the file's labels
 * alone. */
export function checkCalls(file: WalletFile, known: readonly KnownContract[]): WalletView {
  const calls = file.calls.map((c, i): CallView => {
    const chain = WALLET_CHAINS[c.chainId];
    const k = known.find((x) => x.chainId === c.chainId && x.address.toLowerCase() === c.to.toLowerCase());
    if (!k) throw new Error(`call ${i + 1}: ${c.to} on ${chain.name} is not one of this deployment's contracts nor an oracle pool: refusing to show it for signing`);
    const contract = `${k.name} on ${chain.short}`;
    const fn = (() => {
      try {
        return decodeKnownCall(c.data);
      } catch (e) {
        throw new Error(`call ${i + 1}: ${(e as Error).message}`);
      }
    })();
    if (!k.functions.includes(fn.name)) throw new Error(`call ${i + 1}: ${fn.name}() is not a call this tool makes to the ${contract}`);
    return { ...c, to: getAddress(c.to), from: getAddress(c.from), network: chain.name, contract, fn, valueText: `0 ${chain.symbol}` };
  });
  return { ...file, calls };
}

/** "increaseObservationCardinalityNext(1200)" */
export const callText = (fn: DecodedCall) => `${fn.name}(${fn.args.map((x) => x.value).join(", ")})`;

/** The calls as the terminal shows them, to compare with the page and the Ledger's screen. */
export function describeCalls(v: WalletView): string[] {
  const n = v.calls.length;
  const lines = [`${v.title} (prepared ${new Date(v.createdAt).toISOString()}${v.deployment ? `, deployment ${v.deployment}` : ""}): ${n} call${n === 1 ? "" : "s"}`];
  v.calls.forEach((c, i) => {
    const gas = c.gas ? `, gas limit ${Number(c.gas).toLocaleString("en-US")}` : "";
    lines.push(`  ${i + 1}. ${c.network} (chain id ${c.chainId}): ${c.contract} ${c.to}`, `     ${callText(c.fn)}, value ${c.valueText}${gas}, from ${c.from} (${c.sender}): ${c.label}`);
  });
  if (v.ordered) lines.push("  In order: each waits for the one before it to succeed.");
  return lines;
}
