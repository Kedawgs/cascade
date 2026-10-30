import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, decodeFunctionData, encodeFunctionData, getAddress, type Hex, isAddress, parseAbi, toFunctionSelector, zeroAddress } from "viem";

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
/** A file older than this is shown with a warning. */
const STALE_MS = 24 * 3_600_000;

/** Every function the page will send, with its parameters' names to show. Anything else is refused,
 * transferOwnership above all: it is the call that would hand a contract away, and nothing here makes it. */
export const KNOWN_ABI = parseAbi([
  "function acceptOwnership()",
  "function pause()",
  "function unpause()",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
]);
export type KnownFunction = (typeof KNOWN_ABI)[number]["name"];
const POOL_STEP: KnownFunction = "increaseObservationCardinalityNext";

export interface WalletCall {
  chainId: number;
  to: Address;
  /** Lower-case hex, as viem writes it. */
  data: Hex;
  /** Wei, in decimal: always "0", since none of the known functions takes value. */
  value: string;
  /** A gas limit to send with, in decimal: the pool steps only, which a wallet padding its own estimate
   * could push over Base's cap. Every other call takes the wallet's estimate. */
  gas?: string;
  /** The writer's note, e.g. "acceptOwnership() on the vault". Shown only as a note, and it must start
   * with the function the data calls. */
  label: string;
  /** The account that must send it: sign checks it is the record's role for the function, and the page
   * refuses any other. */
  from: Address;
}

export interface WalletFile {
  format: typeof WALLET_FILE_FORMAT;
  version: 1;
  /** The writer's note; shown only as a note. */
  title: string;
  /** ms */
  createdAt: number;
  /** The deployment whose record names the contracts called; absent when only the oracle's pools are. */
  deployment?: string;
  /** Each call waits for the one before it to succeed (the pool steps). */
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

const FILE_KEYS = ["format", "version", "title", "createdAt", "deployment", "ordered", "calls"];
const CALL_KEYS = ["chainId", "to", "data", "value", "gas", "label", "from"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Printable ASCII (0x20 to 0x7E) only: no direction overrides, zero-width or control characters. */
const PRINTABLE = /^[\x20-\x7e]*$/;
/** "" when `v` is fine text, else what is wrong with it. */
function textProblem(v: unknown, max: number): string {
  if (typeof v !== "string" || v.length === 0) return "is missing";
  if (v.length > max) return `is longer than ${max} characters`;
  if (!PRINTABLE.test(v)) return "has a character outside printable ASCII (a hidden or direction-changing character?)";
  return "";
}
const unknownKeys = (o: Record<string, unknown>, known: string[]) => Object.keys(o).filter((k) => !known.includes(k));

/** A call file read from disk, checked field by field: anything malformed is refused, not repaired. */
export function parseWalletFile(raw: unknown): WalletFile {
  if (!isRecord(raw) || raw.format !== WALLET_FILE_FORMAT) throw new Error(`not a call file (its format isn't "${WALLET_FILE_FORMAT}"): make one with --for-wallet`);
  if (raw.version !== 1) throw new Error(`call file version ${String(raw.version)}: this tool reads version 1`);
  const extra = unknownKeys(raw, FILE_KEYS);
  if (extra.length) throw new Error(`the call file has fields this tool doesn't know: ${extra.join(", ")}`);
  const title = textProblem(raw.title, 200);
  if (title) throw new Error(`the call file's title ${title}`);
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
    const extraKeys = unknownKeys(c, CALL_KEYS);
    if (extraKeys.length) throw new Error(`call ${i + 1} has fields this tool doesn't know: ${extraKeys.join(", ")}`);
    if (typeof c.chainId !== "number" || !WALLET_CHAINS[c.chainId]) throw bad(`chainId ${String(c.chainId)} is neither Base (8453) nor Bittensor EVM (964)`);
    if (typeof c.to !== "string" || !isAddress(c.to)) throw bad(`to ${String(c.to)} is not an address (or its checksum is wrong)`);
    if (typeof c.from !== "string" || !isAddress(c.from) || c.from.toLowerCase() === zeroAddress) throw bad(`from ${String(c.from)} is not an address (or its checksum is wrong)`);
    if (typeof c.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(c.data) || c.data.length < 10 || c.data.length % 2 !== 0) throw bad("data is not calldata (0x and whole bytes)");
    if (c.data !== c.data.toLowerCase()) throw bad("data must be lower-case hex, as the tools write it");
    if (c.value !== "0") throw bad("value must be 0: none of the known functions takes value");
    if (c.gas !== undefined && (typeof c.gas !== "string" || !/^[1-9]\d{0,7}$/.test(c.gas) || Number(c.gas) > MAX_GAS)) {
      throw bad(`gas ${String(c.gas)} is not a gas limit up to ${MAX_GAS.toLocaleString("en-US")}`);
    }
    const label = textProblem(c.label, 200);
    if (label) throw bad(`label ${label}`);
    return {
      chainId: c.chainId,
      to: c.to as Address,
      data: c.data as Hex,
      value: "0",
      ...(c.gas !== undefined ? { gas: c.gas as string } : {}),
      label: c.label as string,
      from: c.from as Address,
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
    args: fn.inputs.map((p, i) => ({ name: p.name ?? `arg${i}`, type: p.type, value: String(args[i]) })),
  };
}

/** "increaseObservationCardinalityNext(1200)" */
export const callText = (fn: DecodedCall) => `${fn.name}(${fn.args.map((x) => x.value).join(", ")})`;

/** An account the record gives a role that may make a call, e.g. "the owner on Bittensor". */
export interface Sender {
  address: Address;
  role: string;
}

/** A call this tool makes to a contract: who may send it (the record's role holders, or anyone, for the
 * pools), and what it does, in a line. pause and unpause may also come from the role holders the contract
 * names now (`live`, read when the file is served: a guardian or owner replaced on-chain since the
 * record), or carry why that read failed (`liveProblem`), in which case only the record's count. */
export interface KnownCall {
  senders: readonly Sender[] | "anyone";
  live?: readonly Sender[];
  liveProblem?: string;
  effect: (from: Address, fn: DecodedCall) => string;
}

/** A contract the page may call: its role ("Vault"), its chain, and the calls this tool makes to it. */
export interface KnownContract {
  chainId: number;
  address: Address;
  name: string;
  calls: Partial<Record<KnownFunction, KnownCall>>;
}

export interface CallView extends WalletCall {
  /** "Bittensor EVM" */
  network: string;
  /** "Vault on Bittensor" */
  contract: string;
  /** "acceptOwnership() on the Vault (Bittensor)": from the decoded data and the record, not the file. */
  heading: string;
  /** "acceptOwnership(): makes 0x… the owner of the Vault on Bittensor" */
  effect: string;
  /** "the owner on Bittensor, from the deployment record" */
  senderRole: string;
  fn: DecodedCall;
  /** The 4-byte selector, "0x79ba5097", and each 32-byte parameter word as 64 hex digits: what a
   * Ledger's debug-data screens and MetaMask's hex tab show. */
  selector: Hex;
  words: string[];
  /** "0 TAO" */
  valueText: string;
}

export interface WalletView extends Omit<WalletFile, "calls"> {
  /** "Cascade v3-launch: 3 calls to send from MetaMask" */
  heading: string;
  calls: CallView[];
  /** Shown loudly in the terminal and on the page (a file over a day old). */
  warnings: string[];
}

const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

/** Each call checked against `known`, built from the record: its `to` must be a known contract on its
 * chain, its function one this tool makes to that contract, and its `from` the record's role for that
 * function, or for pause and unpause the role the contract names now (KnownCall.live, labelled so), and
 * nothing else (the pool steps: anyone, but one account for the whole file). The label must start with the
 * function the data calls; only a pool step may set a gas limit. What the page and terminal show comes
 * from here: the file's title and labels are only notes. */
export function checkCalls(file: WalletFile, known: readonly KnownContract[], now = Date.now()): WalletView {
  let poolFrom: Address | undefined;
  const calls = file.calls.map((c, i): CallView => {
    const at = `call ${i + 1}`;
    const chain = WALLET_CHAINS[c.chainId];
    const k = known.find((x) => x.chainId === c.chainId && same(x.address, c.to));
    if (!k) throw new Error(`${at}: ${c.to} on ${chain.name} is not one of this deployment's contracts nor an oracle pool: refusing to show it for signing`);
    const contract = `${k.name} on ${chain.short}`;
    let fn: DecodedCall;
    try {
      fn = decodeKnownCall(c.data);
    } catch (e) {
      throw new Error(`${at}: ${(e as Error).message}`);
    }
    const call = k.calls[fn.name];
    if (!call) throw new Error(`${at}: ${fn.name}() is not a call this tool makes to the ${contract}`);
    if (!c.label.startsWith(`${fn.name}(`)) {
      throw new Error(`${at}: its label "${c.label}" doesn't start with ${fn.name}(, the function its data calls: refusing a file whose words and data disagree`);
    }
    if (c.gas !== undefined && fn.name !== POOL_STEP) throw new Error(`${at}: a gas limit is set only on the pool steps; ${fn.name}() takes MetaMask's estimate`);
    let senderRole: string;
    if (call.senders === "anyone") {
      if (poolFrom && !same(poolFrom, c.from)) {
        throw new Error(`${at}: comes from ${c.from}, but the file's other pool steps come from ${poolFrom}: they all come from the one --from account`);
      }
      poolFrom = c.from;
      senderRole = "the account given with --from; anyone may send this";
    } else {
      const matching = (list: readonly Sender[]) => list.filter((s) => same(s.address, c.from)).map((s) => s.role);
      const recorded = matching(call.senders);
      const now = matching(call.live ?? []);
      if (recorded.length) senderRole = `${recorded.join(" and ")}, from the deployment record`;
      else if (now.length) senderRole = now.join(" and ");
      else {
        const read = call.live !== undefined || call.liveProblem !== undefined;
        const expected = [...call.senders, ...(call.live ?? [])].map((s) => `${s.role}, ${s.address}`).join("; or ");
        const unread = call.liveProblem ? `; the contract's live guardian and owner couldn't be read (${call.liveProblem}), so only the record's roles count` : "";
        throw new Error(`${at}: ${c.from} is not a role in the deployment record${read ? " nor read from the contract now" : ""} that may send ${fn.name}() to the ${contract} (${expected})${unread}`);
      }
    }
    const from = getAddress(c.from);
    return {
      ...c,
      to: getAddress(c.to),
      from,
      network: chain.name,
      contract,
      heading: `${callText(fn)} on the ${k.name} (${chain.short})`,
      effect: `${callText(fn)}: ${call.effect(from, fn)}`,
      senderRole,
      fn,
      selector: c.data.slice(0, 10) as Hex,
      words: c.data.slice(10).match(/.{64}/g) ?? [],
      valueText: `0 ${chain.symbol}`,
    };
  });
  const n = calls.length;
  const warnings: string[] = [];
  const ageMs = now - file.createdAt;
  if (ageMs > STALE_MS) {
    warnings.push(
      `This file was prepared ${Math.floor(ageMs / 3_600_000)} hours ago (${new Date(file.createdAt).toISOString()}): make it again with --for-wallet unless you know it is still right.`,
    );
  }
  return { ...file, heading: `Cascade${file.deployment ? ` ${file.deployment}` : ""}: ${n} call${n === 1 ? "" : "s"} to send from MetaMask`, calls, warnings };
}

/** The calls as the terminal shows them, to compare with the page, MetaMask and the Ledger's screens. */
export function describeCalls(v: WalletView): string[] {
  const lines = [`${v.heading} (file prepared ${new Date(v.createdAt).toISOString()})`, ...v.warnings.map((w) => `WARNING: ${w}`)];
  v.calls.forEach((c, i) => {
    lines.push(
      `  ${i + 1}. ${c.heading} ${c.to}`,
      `     ${c.network} (chain id ${c.chainId}), value ${c.valueText}, from ${c.from} (${c.senderRole})`,
      ...(c.gas ? [`     Gas limit ${Number(c.gas).toLocaleString("en-US")}, set by the file`] : []),
      `     ${c.effect}`,
      `     Selector ${c.selector}, ${c.words.length ? c.words.map((w, j) => `parameter ${j + 1}: ${w}`).join(", ") : "no parameters"}`,
      `     The file's note: ${c.label}`,
    );
  });
  if (v.ordered) lines.push("  In order: each waits for the one before it to succeed.");
  return lines;
}
