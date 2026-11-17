import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Abi, type Address, decodeFunctionData, encodeFunctionData, formatEther, getAddress, type Hex, isAddress, parseAbi, toFunctionSelector, zeroAddress } from "viem";

/** The call file `--for-wallet` writes and `pnpm ops sign` serves: calls for a plain account (an owner
 * or guardian on a Ledger, through MetaMask) to send, one per click, from a page on this computer. */
export const WALLET_FILE_FORMAT = "cascade-wallet-calls";

/** The chains the signing page sends on. Nothing else: a call file for the local forks is refused. */
export const WALLET_CHAINS: Record<number, { name: string; short: string; symbol: string }> = {
  8453: { name: "Base", short: "Base", symbol: "ETH" },
  964: { name: "Bittensor EVM", short: "Bittensor", symbol: "TAO" },
};

/** The most gas a file may set on a call, by chain: Base refuses a transaction above 16,777,216 (EIP-7825); on Bittensor
 * the keeper's per-transaction ceiling (keeper/core/ceiling.ts BITTENSOR_TX_GAS_CEILING), which a write-off's execute
 * sets (R6, claim C). */
const MAX_GAS: Record<number, number> = { 8453: 16_777_216, 964: 64_900_000 };
/** writeOffMissingStake(uint256), the vault's scheduled write-off: its execute carries a gas limit the file sets (R6,
 * ChatGPT R2 claim C: the write-off's read is given 45,000,000 whole, which a wallet's estimate need not leave). */
const WRITE_OFF_SELECTOR = toFunctionSelector("writeOffMissingStake(uint256)");
const MAX_CALLS = 20;
/** A file older than this is shown with a warning. */
const STALE_MS = 24 * 3_600_000;

/** Every function the page will send, with its parameters' names to show. Anything else is refused,
 * transferOwnership above all: it is the call that would hand a contract away, and the page never sends it as a call
 * of its own. On a v3.2 contract it is only ever the calldata inside schedule(data) and execute(data), where the
 * scheduler holds it 8 days under the guardian's veto (plan Task 49). The v3.2 functions (Task 49) are the
 * scheduler's entry points and the owner's and the guardian's direct calls that ops writes or the runbook names;
 * each is sent only to a contract whose own ABI (the deployment's frozen build) has it (KnownContract.abi). */
export const KNOWN_ABI = parseAbi([
  "function acceptOwnership()",
  "function pause()",
  "function unpause()",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
  // v3.2 (Task 49)
  "function schedule(bytes data)",
  "function execute(bytes data)",
  "function cancel(bytes32 id)",
  "function removeFrontDoor(uint64 chain, address addr)",
  "function disableBridge(address bridge)",
  "function setPrimaryBridge(address bridge)",
  "function cancelPayoutBatch(bytes32 key, (address user, uint256 shares, uint256 assets)[] payouts)",
  "function setCaps(uint256 minDeposit_, uint256 depositCap_)",
  // R6b (U4): the owner's batch limits, the fallback that closes a batch held just under its value limit (runbook 7.10)
  "function setBatchLimits(uint32 maxDeposits_, uint32 maxRedeems_)",
  "function setMaxTotalAssets(uint256 amount)",
  "function addHotkey(bytes32 h)",
  "function setStakeHotkey(bytes32 h)",
  // Task 53: the owner's or the guardian's removal of a hotkey (pnpm ops remove-hotkey --for-wallet), and the treasury's
  // own redeem origin (pnpm ops set-redeem-origin --for-wallet)
  "function removeHotkey(bytes32 h, bool forfeit)",
  "function setRedeemOrigin(uint64 chain)",
  // Task 53's fix round: the owner's keeper rotation (both contracts, at once), an immediate raise of the vault's idle
  // buffer, and the Bittensor adapter's reserve (payable, anyone: the one call a file may give value, up to its cap)
  "function setKeeper(address newKeeper)",
  "function setIdleBuffer(uint256 bps)",
  // R5 Minor 3: the owner's claimGasRequired, immediate either way within the vault's bounds (pnpm ops set-claim-gas)
  "function setClaimGasRequired(uint256 gasRequired)",
  "function fundReserve() payable",
  // merge 7b (R4, F-1): the Bittensor adapter's token cushion, booked: the account's approve of the adapter on the
  // adapter's own bridged token, then fundCushion (pnpm ops fund-cushion). The page sends approve only to that token,
  // only for that adapter, and each for at most the cushion's target (sign.ts)
  "function approve(address spender, uint256 amount)",
  "function fundCushion(uint256 amount)",
]);
export type KnownFunction = (typeof KNOWN_ABI)[number]["name"];
const POOL_STEP: KnownFunction = "increaseObservationCardinalityNext";
/** The most stamps one file asks the owner to sign: a 30-day stack, a stamp every 12 hours, on both chains. */
const MAX_STAMPS = 120;

export interface WalletCall {
  chainId: number;
  to: Address;
  /** Lower-case hex, as viem writes it. */
  data: Hex;
  /** Wei, in decimal: "0" for every call but one that takes value (the adapter's fundReserve(), up to its cap: KnownCall
   * maxValue), which the page checks against its contract. */
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

/** A typed-data request (Task 49): the owner's signed stamp (spec §3.6, OwnerStamp(uint64 asOf)) for the vault on
 * Bittensor or the front door on Base, which the page has the owner's Ledger sign (eth_signTypedData_v4) and hands to
 * pnpm ops stamp's relay path. The page builds the typed data itself from these, never from the file's words. */
export interface StampRequest {
  chainId: number;
  /** the contract the stamp is for: its EIP-712 verifyingContract */
  contract: Address;
  /** the stamp's time, in seconds, in decimal: its chain's head time when it was prepared */
  asOf: string;
  /** the owner, who signs it */
  from: Address;
  /** relay: relayed at once from the relayer; stack: added to the relayer's stack, relayed from its time by relay-due */
  mode: "relay" | "stack";
  /** the writer's note; shown only as a note */
  label: string;
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
  /** A file of stamps to sign (Task 49) holds no calls: one or the other. */
  stamps?: StampRequest[];
  /** A rail change written past the rail check with --one-sided (Task 47b): the founder's reason, which the sign page
   * shows with its warning. Absent from every other file. */
  oneSided?: string;
  /** R4 (D-L4): the guardian's emergency pause written with no chain read (pnpm ops pause --for-wallet --offline), which
   * a v3.2 sign page serves with no chain read either, and only while every call is a pause() of the record's. Absent
   * from every other file. */
  offline?: true;
}

export type NewWalletCall = Omit<WalletCall, "value" | "gas"> & { gas?: number | bigint; value?: bigint };

/** A call file, or a file of stamps to sign. Refuses a chain the page doesn't send on (the local forks among them). */
export function walletFile(o: { title: string; deployment?: string; ordered?: boolean; now: number; calls: NewWalletCall[]; stamps?: StampRequest[]; oneSided?: string; offline?: true }): WalletFile {
  for (const c of [...o.calls, ...(o.stamps ?? [])]) {
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
    calls: o.calls.map(({ gas, value, ...c }) => ({ ...c, value: (value ?? 0n).toString(), ...(gas !== undefined ? { gas: gas.toString() } : {}) })),
    ...(o.stamps?.length ? { stamps: o.stamps.map((s) => ({ ...s })) } : {}),
    ...(o.oneSided !== undefined ? { oneSided: o.oneSided } : {}),
    ...(o.offline ? { offline: true as const } : {}),
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

/** The line a command prints once it has written a file of stamps for the owner to sign. */
export const wroteStampsLine = (path: string, n: number, then: string) =>
  `Wrote ${path} (${n} stamp${n === 1 ? "" : "s"}): have the owner's Ledger sign ${n === 1 ? "it" : "them"} on the sign page, which ${then}: pnpm ops sign ${path}`;

const FILE_KEYS = ["format", "version", "title", "createdAt", "deployment", "ordered", "calls", "stamps", "oneSided", "offline"];
const CALL_KEYS = ["chainId", "to", "data", "value", "gas", "label", "from"];
const STAMP_KEYS = ["chainId", "contract", "asOf", "from", "mode", "label"];
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
  if (raw.oneSided !== undefined) {
    const why = textProblem(raw.oneSided, 200);
    if (why) throw new Error(`the call file's one-sided reason ${why}`);
  }
  const oneSided = raw.oneSided !== undefined ? { oneSided: raw.oneSided as string } : {};
  if (raw.offline !== undefined && raw.offline !== true) throw new Error("the call file's offline is not true (it is absent from a file made with chain reads)");
  const offline = raw.offline === true ? { offline: true as const } : {};
  const stamps = raw.stamps === undefined ? undefined : parseStamps(raw.stamps);
  if (stamps) {
    if (!Array.isArray(raw.calls) || raw.calls.length !== 0) throw new Error("the file holds stamps to sign and calls to send: a file holds one or the other");
    if (raw.ordered) throw new Error("a file of stamps is not ordered: each stamp is signed with its own button");
    if (raw.oneSided !== undefined) throw new Error("a file of stamps carries no one-sided reason: that is for a rail change's calls");
    if (raw.offline !== undefined) throw new Error("a file of stamps is never offline: a stamp is checked against the chain");
    return { format: WALLET_FILE_FORMAT, version: 1, title: raw.title as string, createdAt: raw.createdAt, ...(raw.deployment !== undefined ? { deployment: raw.deployment as string } : {}), ordered: false, calls: [], stamps };
  }
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
    // an amount in wei; anything but 0 only for a call that takes value, judged against its contract (checkCalls)
    if (typeof c.value !== "string" || !/^(0|[1-9]\d{0,29})$/.test(c.value)) throw bad("value must be an amount in wei, in decimal (0 for every call but one that takes value)");
    const maxGas = MAX_GAS[c.chainId];
    if (c.gas !== undefined && (typeof c.gas !== "string" || !/^[1-9]\d{0,7}$/.test(c.gas) || Number(c.gas) > maxGas)) {
      throw bad(`gas ${String(c.gas)} is not a gas limit up to ${maxGas.toLocaleString("en-US")} (${WALLET_CHAINS[c.chainId].name}'s most)`);
    }
    const label = textProblem(c.label, 200);
    if (label) throw bad(`label ${label}`);
    return {
      chainId: c.chainId,
      to: c.to as Address,
      data: c.data as Hex,
      value: c.value,
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
    ...oneSided,
    ...offline,
  };
}

/** A file's stamp requests, checked field by field: anything malformed is refused, not repaired. */
function parseStamps(raw: unknown): StampRequest[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("the file's stamps are not a list of stamps");
  if (raw.length > MAX_STAMPS) throw new Error(`the file has ${raw.length} stamps: at most ${MAX_STAMPS}`);
  return raw.map((s: unknown, i: number): StampRequest => {
    const bad = (what: string) => new Error(`stamp ${i + 1}: ${what}`);
    if (!isRecord(s)) throw bad("is not an object");
    const extra = unknownKeys(s, STAMP_KEYS);
    if (extra.length) throw new Error(`stamp ${i + 1} has fields this tool doesn't know: ${extra.join(", ")}`);
    if (typeof s.chainId !== "number" || !WALLET_CHAINS[s.chainId]) throw bad(`chainId ${String(s.chainId)} is neither Base (8453) nor Bittensor EVM (964)`);
    if (typeof s.contract !== "string" || !isAddress(s.contract)) throw bad(`contract ${String(s.contract)} is not an address (or its checksum is wrong)`);
    if (typeof s.from !== "string" || !isAddress(s.from) || s.from.toLowerCase() === zeroAddress) throw bad(`from ${String(s.from)} is not an address (or its checksum is wrong)`);
    if (typeof s.asOf !== "string" || !/^(0|[1-9]\d{0,19})$/.test(s.asOf) || BigInt(s.asOf) >= 1n << 64n) throw bad(`asOf ${String(s.asOf)} is not a time in seconds (a uint64, in decimal)`);
    if (s.mode !== "relay" && s.mode !== "stack") throw bad(`mode ${String(s.mode)} is neither relay nor stack`);
    const label = textProblem(s.label, 200);
    if (label) throw bad(`label ${label}`);
    return { chainId: s.chainId, contract: s.contract as Address, asOf: s.asOf, from: s.from as Address, mode: s.mode, label: s.label as string };
  });
}

export interface DecodedCall {
  name: KnownFunction;
  /** e.g. increaseObservationCardinalityNext(uint16) */
  signature: string;
  args: { name: string; type: string; value: string }[];
}

/** A decoded value as text: a number or an address as it is, a list and a tuple field by field. */
export const valueText = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(valueText).join(", ")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.entries(v)
          .map(([k, x]) => `${k}: ${valueText(x)}`)
          .join(", ")}}`
      : String(v);

/** `data`'s function from KNOWN_ABI and its arguments, as text. Refuses an unknown selector, and
 * calldata that isn't exactly the standard encoding of what it decodes to (extra bytes, a value outside
 * its type), since a contract could read such bytes differently from what is shown. */
/** The selector of the call inside execute(bytes data)'s data, or undefined when it doesn't decode. */
function innerSelector(data: Hex): string | undefined {
  try {
    const inner = decodeFunctionData({ abi: KNOWN_ABI, data }).args?.[0];
    return typeof inner === "string" ? inner.slice(0, 10).toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

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
    signature: `${fn.name}(${fn.inputs.map((p) => typeText(p, false)).join(",")})`,
    args: fn.inputs.map((p, i) => ({ name: p.name ?? `arg${i}`, type: typeText(p, true), value: valueText(args[i]) })),
  };
}

/** A parameter's type as a signature writes it, a tuple as its components: "(address,uint256,uint256)[]", or with their
 * names, "(address user, uint256 shares, uint256 assets)[]". */
function typeText(p: { type: string; name?: string; components?: readonly { type: string; name?: string }[] }, named: boolean): string {
  if (!p.type.startsWith("tuple")) return p.type;
  const inner = (p.components ?? []).map((c) => (named && c.name ? `${typeText(c, true)} ${c.name}` : typeText(c, false))).join(named ? ", " : ",");
  return `(${inner})${p.type.slice("tuple".length)}`;
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
  /** The most value (wei) the call may carry: absent, it carries none. Only the Bittensor adapter's fundReserve() has one
   * (Task 53's fix round). */
  maxValue?: bigint;
}

/** A contract the page may call: its role ("Vault"), its chain, and the calls this tool makes to it. */
export interface KnownContract {
  chainId: number;
  address: Address;
  name: string;
  calls: Partial<Record<KnownFunction, KnownCall>>;
  /** The contract's own ABI, from the deployment's frozen build (a v3.2 contract): a call is sent only when this ABI
   * has its function, by name and selector. Absent for v3-launch's contracts and the pools, which KNOWN_ABI alone
   * decodes as before. */
  abi?: Abi;
}

/** One more thing the page shows about a call, in rows of its own: a v3.2 call's scheduled setter, its kind and class,
 * when it is ready, its item's copies, what it changes (Task 49). */
export interface CallDetail {
  name: string;
  lines: string[];
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
  /** A v3.2 call's rows of its own (Task 49): none for v3-launch's calls. */
  details?: CallDetail[];
  /** Shown loudly on this call: a loosening, an owner's door removal, caps above the founder level without a Safe.
   * Warnings only: none of them stops the call. */
  callWarnings?: string[];
  /** Asked again of the chain by pnpm ops sign just before the page sends it, and not sent if it fails (a door
   * removal's guard, Task 46b's I2): what is checked, in words. */
  recheck?: string;
}

/** A stamp request as checked against the deployment and its contracts when the page is served (Task 49): what the
 * page shows, and the typed data it asks the owner's Ledger to sign, built here, never taken from the file. */
export interface StampView extends StampRequest {
  /** "Bittensor EVM" */
  network: string;
  /** "Vault on Bittensor" */
  contractName: string;
  /** "The owner's stamp on the Vault (Bittensor), as of 2030-03-17T17:46:40Z" */
  heading: string;
  /** what it does, in a line */
  effect: string;
  /** asOf as a date (UTC) */
  asOfText: string;
  domainHash: Hex;
  /** the struct hash: what a Ledger signing blind shows as the message hash */
  messageHash: Hex;
  digest: Hex;
  /** what happens to the signature, in a line */
  then: string;
  /** what the Sign click does besides signing, said before it (a relay stamp's also sends stampBySig) */
  click: string;
  /** eth_signTypedData_v4's typed data, as JSON */
  typedData: string;
}

export interface WalletView extends Omit<WalletFile, "calls" | "stamps"> {
  /** "Cascade v3-launch: 3 calls to send from MetaMask" */
  heading: string;
  calls: CallView[];
  /** A file of stamps (Task 49): what the owner signs. */
  stamps?: StampView[];
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
    // a v3.2 contract: its own ABI (the frozen build's) must have the function, so the page decodes with the contract's
    if (k.abi && !k.abi.some((x) => x.type === "function" && x.name === fn.name && toFunctionSelector(x) === c.data.slice(0, 10))) {
      throw new Error(`${at}: ${fn.signature} is not in the ${contract}'s ABI (the deployment's frozen build): refusing to show calldata its contract would read differently`);
    }
    if (!c.label.startsWith(`${fn.name}(`)) {
      throw new Error(`${at}: its label "${c.label}" doesn't start with ${fn.name}(, the function its data calls: refusing a file whose words and data disagree`);
    }
    // R6 (claim C): a write-off's execute on Bittensor goes with the gas limit its file sets, never a wallet's estimate
    const writeOff = fn.name === "execute" && c.chainId === 964 && innerSelector(c.data) === WRITE_OFF_SELECTOR;
    if (writeOff && c.gas === undefined) throw new Error(`${at}: a write-off's execute goes with the gas limit pnpm ops execute sets in its file, never a wallet's estimate: this one sets none`);
    if (c.gas !== undefined && fn.name !== POOL_STEP && !writeOff) throw new Error(`${at}: a gas limit is set only on the pool steps and a write-off's execute; ${fn.name}() takes MetaMask's estimate`);
    // value: none, but for a call that takes it, up to its cap
    const value = BigInt(c.value);
    if (value !== 0n && call.maxValue === undefined) throw new Error(`${at}: it carries ${formatEther(value)} ${chain.symbol}, but ${fn.name}() takes no value`);
    if (call.maxValue !== undefined && value > call.maxValue) throw new Error(`${at}: it carries ${formatEther(value)} ${chain.symbol}, more than the ${formatEther(call.maxValue)} ${chain.symbol} ${fn.name}() may carry`);
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
      valueText: `${formatEther(BigInt(c.value))} ${chain.symbol}`,
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
  const { stamps: _stamps, ...rest } = file;
  return { ...rest, heading: `Cascade${file.deployment ? ` ${file.deployment}` : ""}: ${n} call${n === 1 ? "" : "s"} to send from MetaMask`, calls, warnings };
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
      ...(c.callWarnings ?? []).map((w) => `     WARNING: ${w}`),
      ...(c.details ?? []).map((d) => `     ${d.name}: ${d.lines.join("; ")}`),
      ...(c.recheck ? [`     Just before it is sent, the page asks this server to check again: ${c.recheck}.`] : []),
      `     Selector ${c.selector}, ${c.words.length ? c.words.map((w, j) => `parameter ${j + 1}: ${w}`).join(", ") : "no parameters"}`,
      `     The file's note: ${c.label}`,
    );
  });
  (v.stamps ?? []).forEach((s, i) => {
    lines.push(
      `  ${i + 1}. ${s.heading}`,
      `     ${s.contractName} ${s.contract}, ${s.network} (chain id ${s.chainId}), signed by the owner ${s.from}`,
      `     ${s.effect}`,
      `     As of ${s.asOf} (${s.asOfText})`,
      `     Domain hash ${s.domainHash}, message hash ${s.messageHash}, digest ${s.digest}`,
      `     Then: ${s.then}`,
      `     The file's note: ${s.label}`,
    );
  });
  if (v.ordered) lines.push("  In order: each waits for the one before it to succeed.");
  return lines;
}
