import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type Address,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  type Hex,
  hexToBigInt,
  hexToNumber,
  keccak256,
  numberToHex,
  parseAbi,
  recoverAddress,
  slice,
  stringToBytes,
  type TransactionSerializable,
  type TypedDataDefinition,
} from "viem";
import { type ChainName, type Env, gweiOf, WALLET } from "../config.ts";
import { takeRunLock } from "../keeper/runlock.ts";
import { balanceOf, gasPriceOf, priorityFeeOf, read } from "../rpc.ts";
import { type Ctx, chainLabel, describeRevert, gate, redact, revertReason, type Sent, type Signer, settle, signerOf, signingAccount, signTransaction, unit, waitReceipt } from "../send.ts";
import { type StampRequest, walletFile, writeWalletFile, wroteStampsLine } from "../wallet.ts";
import { VAULT_ABI_V32 } from "./abi.ts";
import { buildErrorsV32, loadBuildV32 } from "./build.ts";
import { readDoor, readVault } from "./lens.ts";
import { ask, type BuildsOpt, checkChains, chainIdFor, firstLine, type RecordV32, where } from "./scheduler.ts";
import { V3_LAUNCH_KEEPER } from "./settings.ts";
import { gapRiskLine, STAMP_SPACING_HOURS, stackBoundsProblem } from "./stamp-bounds.ts";

export { MAX_STACK_DAYS, STAMP_SPACING_HOURS } from "./stamp-bounds.ts";

// The owner's signed stamp (spec §3.6; plan Task 48; Review Focus 2). stampBySig(asOf, sig) on the vault (Bittensor)
// and the front door (Base) takes the owner's EIP-712 signature of OwnerStamp(asOf), domain "Cascade" "3.2", from any
// account, and moves the owner's clock to asOf, killing every item scheduled at or before it. It is the defence
// against a copied owner seed (the CO walk): stamps pre-signed for a bot kill whatever a thief schedules. So:
// - the hashes are the contract's (stampHashes, CascadeBase.stampBySig's formula, pinned to StampVector.sol's vector),
//   and before the owner is asked to sign, the lens's DOMAIN_SEPARATOR and STAMP_TYPEHASH must be ops's;
// - asOf is each chain's head time, never the wall clock (a Bittensor head behind the wall clock would refuse a stamp
//   dated by it, StampOutOfWindow), and a stamp outside [asOf, asOf + STAMP_MAX_TTL] by the head, or within a minute of
//   its end (its block could come too late), is refused before anything is asked or sent;
// - a signature is normalised to the contract's one shape (65 bytes, v 27 or 28): v 0 or 1 raised by 27, a 64-byte
//   EIP-2098 one expanded; a high s, any other length and any other v refused; it must recover to the owner the
//   contract names now;
// - stampBySig is asked by eth_call from the relayer first: a revert is reported with the contract's error, nothing sent;
// - the relayer is a fresh key of its own (OPS_RELAYER_KEYSTORE, by path), never an account of the Ledger: one equal to
//   the owner, the guardian or the treasury is refused (ruling B10: ops can only compare it with the accounts it knows),
//   and never a key with a job of its own (a keeper, a deployer, the test wallet), whose pending transaction a tipped
//   relay would replace (Task 48's review, M1 and M2);
// - the stack (ops/stamps/<chain>.json, git-ignored, on the relayer's machine) holds stamps dated from the head, one
//   every STAMP_SPACING_HOURS (12) by default (the review's I1: further apart only with --accept-gap-risk); --relay-due
//   relays the newest stamp the head has reached that is more than a minute from expiring, which covers the older due
//   ones (the clock moves to the latest), so the stack never sends a stamp from the future of the moment it is relayed;
//   a stamp missed or never signed, or a stack run out, fails the run (M3, M5);
// - --tip pays a priority fee (a higher gas price on Bittensor's legacy transactions) for the race when a halted chain
//   resumes, and replaces the relayer's own pending relay.
// The Ledger's signature comes from the sign page (ruling C3; Task 49): with a wallet folder (the CLI's
// deployments/wallet/), prepare and --stack also write the stamps as a file for pnpm ops sign, whose page has the owner's
// Ledger sign each (eth_signTypedData_v4, MetaMask switched to the stamp's chain) and hands the signature back to relay
// or --to-stack here. --sig takes one by hand still.

/** CascadeConstants.STAMP_MAX_TTL: a stamp is good from its asOf until a day after it. */
export const STAMP_MAX_TTL = 86_400n;
/** CascadeConstants.STAMP_TYPEHASH: keccak256("OwnerStamp(uint64 asOf)"). */
export const STAMP_TYPEHASH: Hex = keccak256(stringToBytes("OwnerStamp(uint64 asOf)"));
/** The EIP-712 domain's type hash, CascadeFormulas.domainSeparator's. */
const DOMAIN_TYPEHASH: Hex = keccak256(stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const NAME_HASH: Hex = keccak256(stringToBytes("Cascade"));
const VERSION_HASH: Hex = keccak256(stringToBytes("3.2"));
/** The secp256k1 curve order, and its half: the contract takes s only up to n / 2. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N / 2n;
/** The highest --tip taken, in gwei: a stamp's gas is small, but a typo of a tip is not. */
export const TIP_MAX_GWEI = 1_000n;
/** The least time a stamp must have left to be relayed, in seconds: its block comes after the head, and a stamp that
 * expires before that block reverts (StampOutOfWindow), its gas spent for nothing (Task 48's review, M5). */
export const EXPIRY_MARGIN = 60n;
/** The stack's lead time: --relay-due warns when its last signed stamp is less than this ahead of the head. */
const LEAD_TIME = 2n * 86_400n;

/** What ops sends and reads of the stamp (the contracts' own, held to the published vault ABI and the front door's by
 * test/v32-stamp.test.ts). */
export const STAMP_ABI = parseAbi([
  "function stampBySig(uint64 asOf, bytes sig)",
  "function owner() view returns (address)",
  "event StampedBySig(uint64 asOf, address indexed relayer)",
  "error BadStamp()",
  "error StampOutOfWindow()",
]);

/** The stamp's EIP-712 types, its domain's included (eth_signTypedData_v4 takes them all). */
export const STAMP_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  OwnerStamp: [{ name: "asOf", type: "uint64" }],
} as const;

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const checkAsOf = (asOf: bigint) => {
  if (asOf < 0n || asOf >= 1n << 64n) throw new Error(`asOf ${asOf} is not a uint64 time in seconds; nothing signed or sent`);
};
const isoOf = (t: bigint) => new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z");
const seconds = (n: bigint) => `${n} second${n === 1n ? "" : "s"}`;

/** The owner's stamp as of `asOf` on the contract `contract` of chain `chainId`, as EIP-712 typed data: domain
 * "Cascade", "3.2", the chain id and the contract; type OwnerStamp(uint64 asOf). */
export function stampTypedData(chainId: number, contract: Address, asOf: bigint): TypedDataDefinition<typeof STAMP_TYPES, "OwnerStamp"> {
  checkAsOf(asOf);
  return {
    domain: { name: "Cascade", version: "3.2", chainId: BigInt(chainId), verifyingContract: getAddress(contract) },
    types: STAMP_TYPES,
    primaryType: "OwnerStamp",
    message: { asOf },
  };
}

/** The same typed data as JSON, for eth_signTypedData_v4 (and `cast wallet sign --data --from-file`): asOf as a decimal
 * string. test/fixtures/stamp-vector-*.json are this for StampVector.sol's vector. */
export function stampTypedDataJson(chainId: number, contract: Address, asOf: bigint) {
  const t = stampTypedData(chainId, contract, asOf);
  return { types: t.types, primaryType: t.primaryType, domain: { ...t.domain, chainId }, message: { asOf: asOf.toString() } };
}

/** The stamp's hashes exactly as CascadeBase.stampBySig computes them: the domain separator (CascadeFormulas
 * .domainSeparator, for `chainId` and `contract`), the struct hash keccak256(abi.encode(STAMP_TYPEHASH, asOf)) and the
 * digest keccak256("\x19\x01" ‖ domain ‖ struct), which the owner signs. Written out here, not through viem's EIP-712,
 * so the two are held against each other (and both against StampVector.sol's vector). The Ledger, signing EIP-712
 * blind, shows the domain hash and the struct hash (its "message hash"). */
export function stampHashes(chainId: number, contract: Address, asOf: bigint): { domainHash: Hex; structHash: Hex; digest: Hex } {
  checkAsOf(asOf);
  const domainHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(chainId), getAddress(contract)],
    ),
  );
  const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint64" }], [STAMP_TYPEHASH, asOf]));
  return { domainHash, structHash, digest: keccak256(concat(["0x1901", domainHash, structHash])) };
}

/** A signature in the one shape the contract takes: 65 bytes (r, s, v) with v 27 or 28. A v of 0 or 1 (a Ledger through
 * some wallets) is raised by 27, and a 64-byte EIP-2098 compact signature (r, then s with v's parity in its top bit) is
 * expanded. Refused: a high s (above n / 2, which the contract refuses), a zero or out-of-range r or s, any other v, any
 * other length, and anything that is not hex bytes. Upper-case hex and spaces around it are taken. */
export function normaliseSignature(sig: string): Hex {
  const text = sig.trim();
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(text)) throw new Error(`the signature "${text.length > 20 ? `${text.slice(0, 20)}…` : text}" is not hex bytes (0x…); nothing sent`);
  const hex = text.toLowerCase() as Hex;
  const bytes = (hex.length - 2) / 2;
  let r: bigint;
  let s: bigint;
  let v: number;
  if (bytes === 65) {
    r = hexToBigInt(slice(hex, 0, 32));
    s = hexToBigInt(slice(hex, 32, 64));
    v = hexToNumber(slice(hex, 64, 65));
    if (v === 0 || v === 1) v += 27;
    else if (v !== 27 && v !== 28) throw new Error(`the signature's v is ${v}: the contract takes 27 or 28 (a 0 or 1 is raised by 27); nothing sent`);
  } else if (bytes === 64) {
    r = hexToBigInt(slice(hex, 0, 32));
    const vs = hexToBigInt(slice(hex, 32, 64));
    v = 27 + Number(vs >> 255n);
    s = vs & ((1n << 255n) - 1n);
  } else {
    throw new Error(`the signature is ${bytes} bytes: the contract takes 65 (r, s, v), and ops expands a 64-byte compact one (EIP-2098); nothing sent`);
  }
  if (r === 0n || r >= N || s === 0n) throw new Error("the signature's r or s is zero or out of range: it is no signature; nothing sent");
  if (s > HALF_N) throw new Error("the signature has a high s (above half the curve order): the contract refuses it; nothing sent");
  return concat([numberToHex(r, { size: 32 }), numberToHex(s, { size: 32 }), numberToHex(v, { size: 1 })]);
}

/** The chain's latest block's timestamp: the clock a stamp is dated and judged by, never the wall clock. */
export async function headTime(ctx: Pick<Ctx, "rpc">, chain: ChainName): Promise<bigint> {
  const b = (await ctx.rpc.request(chain, "eth_getBlockByNumber", ["latest", false])) as { timestamp: Hex } | null;
  if (!b) throw new Error(`${chainLabel(chain)} has no latest block`);
  return hexToBigInt(b.timestamp);
}

/** Why a stamp as of `asOf` can't be relayed at the chain's head time `head`, or null: the contract takes it only while
 * asOf <= now <= asOf + STAMP_MAX_TTL, and one with less than EXPIRY_MARGIN left could expire before its block. */
export function windowProblem(asOf: bigint, head: bigint, chain: ChainName): string | null {
  const c = chainLabel(chain);
  if (asOf > head) {
    return `the stamp as of ${asOf} (${isoOf(asOf)}) is ${seconds(asOf - head)} in the future of ${c}'s head (${isoOf(head)}): the contract refuses it (StampOutOfWindow) until then; nothing sent`;
  }
  if (head > asOf + STAMP_MAX_TTL) {
    return `the stamp as of ${asOf} (${isoOf(asOf)}) expired at ${isoOf(asOf + STAMP_MAX_TTL)} by ${c}'s head (${isoOf(head)}): the contract refuses it (StampOutOfWindow); have the owner sign a new one; nothing sent`;
  }
  if (asOf + STAMP_MAX_TTL - head < EXPIRY_MARGIN) {
    return `the stamp as of ${asOf} (${isoOf(asOf)}) expires at ${isoOf(asOf + STAMP_MAX_TTL)}, less than a minute after ${c}'s head (${isoOf(head)}): its block could come too late (StampOutOfWindow); have the owner sign a new one; nothing sent`;
  }
  return null;
}

/** An account the relayer must not be, by what it is: one of the Ledger's (`ledger`), or a key with a job of its own. */
export interface RefusedAccount {
  name: string;
  address: Address;
  ledger: boolean;
}

/** Why `relayer` must not relay, or null: it is one of the Ledger's accounts ops knows (ruling B10), whose gas a copied
 * seed would sweep too, or a key with a job of its own, whose pending transaction a tipped relay would replace. */
export function relayerProblem(relayer: Address, refused: readonly RefusedAccount[]): string | null {
  const hit = refused.find((a) => same(a.address, relayer));
  if (!hit) return null;
  const why = hit.ledger
    ? "an account of the Ledger: a copied seed would sweep its gas too"
    : "a key with a job of its own: a relay with --tip could replace that job's pending transaction";
  return `the relayer ${getAddress(relayer)} is ${hit.name}, ${why}. Relay from a fresh key of its own (cast wallet new); nothing sent`;
}

/** The refusal of a signature that recovers to another account than `owner`. */
async function mustBeTheOwners(digest: Hex, sig: Hex, owner: Address, what: string, nothing: string): Promise<void> {
  let by: Address;
  try {
    by = await recoverAddress({ hash: digest, signature: sig });
  } catch {
    throw new Error(`the signature recovers to no account; ${nothing}`);
  }
  if (!same(by, owner)) throw new Error(`the signature is ${by}'s, not the owner ${getAddress(owner)}'s, for ${what}: it may be for another chain, contract or time; ${nothing}`);
}

const STAMP_ERRORS: Abi = VAULT_ABI_V32.filter((i) => i.type === "error");

export interface RelayOpts {
  /** A priority fee in gwei: Base's maxPriorityFeePerGas, or added to Bittensor's gas price (legacy transactions). */
  tipGwei?: bigint;
  /** The accounts the relayer must not be (relayerRefusals), besides the owner the contract names now, which relayStamp
   * reads itself. Required (Task 48's review, M1): a caller can't skip the guardian, the treasury or the hot keys. */
  ledger: readonly RefusedAccount[];
  /** The errors a revert is named from: the deployment's build's (the published vault ABI's by default). */
  errors?: Abi;
  /** How the stamp is named in a line. */
  label?: string;
}

/** Relays the owner's stamp as of `asOf` to `contract` on `chain` from the context's signer, the relayer: the signature
 * normalised, the live gate and chain id, the relayer never an account of the Ledger (the owner the contract names now,
 * and `o.ledger`), the signature the owner's for this chain, contract and time, the window by the chain's head, then
 * stampBySig asked by eth_call from the relayer: any refusal or revert sends nothing. Then a signed raw transaction
 * (signTransaction: the keystore signs its hash; the result is decoded back and must be this one, from the relayer),
 * broadcast, and its receipt waited for: a revert on chain throws RevertedOnChain with its reason. */
export async function relayStamp(ctx: Ctx, chain: ChainName, contract: Address, asOf: bigint, sig: Hex, o: RelayOpts): Promise<Sent> {
  if (!o?.ledger?.length) throw new Error("relayStamp needs the accounts the relayer must not be (relayerRefusals); nothing sent");
  const signature = normaliseSignature(sig);
  checkAsOf(asOf);
  if (!ctx.signer) throw new Error("a stamp is relayed from the relayer's keystore (OPS_RELAYER_KEYSTORE), which this run doesn't name; nothing sent");
  const relayer = ctx.signer;
  const to = getAddress(contract);
  await gate(ctx, chain);
  const owner = getAddress((await read(ctx.rpc, chain, { address: to, abi: STAMP_ABI, functionName: "owner" })) as Address);
  const problem = relayerProblem(relayer.address, [{ name: "the owner", address: owner, ledger: true }, ...o.ledger]);
  if (problem) throw new Error(problem);
  const { digest } = stampHashes(ctx.targets[chain].chainId, to, asOf);
  await mustBeTheOwners(digest, signature, owner, `this stamp (as of ${asOf} on ${chainLabel(chain)}, contract ${to})`, "nothing sent");
  const late = windowProblem(asOf, await headTime(ctx, chain), chain);
  if (late) throw new Error(late);
  const data = encodeFunctionData({ abi: STAMP_ABI, functionName: "stampBySig", args: [asOf, signature] });
  const errors = o.errors ?? STAMP_ERRORS;
  const a = await ask(ctx, chain, { from: relayer.address, to, data }, errors);
  if (a.kind === "unread") throw new Error(`Couldn't check stampBySig(${asOf}) on ${chainLabel(chain)} right now (the RPC did not run it: ${a.why}); try again; nothing sent`);
  if (a.kind === "reverted") throw new Error(`stampBySig(${asOf}) on ${chainLabel(chain)} ${to} would revert: ${a.error}; nothing sent`);
  return sendStamp(ctx, chain, to, data, o.label ?? "the stamp", o.tipGwei, errors);
}

/** The relay's transaction: at the relayer's mined nonce (a pending relay of its own is replaced, with a tip only), 1.25
 * times the estimate, the fees with the tip, the gas covered by the relayer's balance; signed, broadcast, mined. */
async function sendStamp(ctx: Ctx, chain: ChainName, to: Address, data: Hex, label: string, tipGwei: bigint | undefined, errors: Abi): Promise<Sent> {
  const c = chainLabel(chain);
  const t = ctx.targets[chain];
  const from = signerOf(ctx).address;
  if (tipGwei !== undefined && (tipGwei < 0n || tipGwei > TIP_MAX_GWEI)) throw new Error(`a tip of ${tipGwei} gwei is outside 0 to ${TIP_MAX_GWEI}; nothing sent`);
  const latest = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [from, "latest"])) as Hex);
  const pending = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [from, "pending"])) as Hex);
  if (pending > latest && tipGwei === undefined) {
    throw new Error(`${c}: an earlier transaction from the relayer (nonce ${latest}) is still waiting to be mined: wait for it, or replace it with --tip <gwei>; nothing sent`);
  }
  let gas: bigint;
  try {
    gas = hexToBigInt((await ctx.rpc.request(chain, "eth_estimateGas", [{ from, to, data }])) as Hex);
  } catch (e) {
    throw new Error(`${c}: ${label} would fail (${describeRevert(e, errors)}); nothing sent`);
  }
  const limit = (gas * 125n + 99n) / 100n;
  const price = await gasPriceOf(ctx.rpc, chain);
  const cap = ctx.maxGasPrice?.[chain];
  if (cap !== undefined && price > cap) throw new Error(`${c}: the gas price is ${gweiOf(price)}, over the ${gweiOf(cap)} cap; nothing sent`);
  const tip = tipGwei === undefined ? undefined : tipGwei * 10n ** 9n;
  let tx: TransactionSerializable;
  let perGas: bigint;
  let paid: bigint;
  if (t.legacy) {
    perGas = price + (tip ?? 0n);
    paid = perGas;
    tx = { type: "legacy", chainId: t.chainId, nonce: latest, gas: limit, gasPrice: perGas, to, data, value: 0n };
  } else {
    // the node's suggested tip, never above its own gas price (its base fee and that tip together)
    const suggested = await priorityFeeOf(ctx.rpc, chain);
    const priority = tip ?? (suggested < price ? suggested : price);
    perGas = 2n * price + priority;
    paid = price + priority;
    tx = { type: "eip1559", chainId: t.chainId, nonce: latest, gas: limit, maxFeePerGas: perGas, maxPriorityFeePerGas: priority, to, data, value: 0n };
  }
  const need = limit * perGas;
  const holds = await balanceOf(ctx.rpc, chain, from);
  if (holds < need) {
    throw new Error(
      `${c}: the relayer ${from} holds ${formatEther(holds)} ${unit(chain)}, but ${label} can cost up to ${formatEther(need)} ${unit(chain)} (${limit.toLocaleString("en-US")} gas at ${gweiOf(perGas)}): fund it; nothing sent`,
    );
  }
  const replaces = pending > latest ? `, replacing the relayer's pending transaction at nonce ${latest}` : "";
  ctx.log(`${c}: ${label} — est. ${gas.toLocaleString("en-US")} gas ≈ ${formatEther(gas * paid)} ${unit(chain)}${tip !== undefined ? `, with a tip of ${tipGwei} gwei` : ""}${replaces}`);
  const raw = await signTransaction(ctx, tx);
  const hash = keccak256(raw);
  try {
    await ctx.rpc.request(chain, "eth_sendRawTransaction", [raw]);
  } catch (e) {
    // the node may have taken it all the same, its answer lost on the way back
    const known = await ctx.rpc.request(chain, "eth_getTransactionByHash", [hash]).catch(() => null);
    if (!known) {
      throw new Error(`${c}: ${label} was not sent (${redact(ctx.targets, firstLine(e))})${replaces ? ": the transaction it replaces may pay more, so raise --tip" : ""}; nothing sent`);
    }
  }
  const r = await waitReceipt(ctx, chain, latest, hash);
  const reason = r.status === "0x1" ? undefined : await revertReason(ctx, chain, { from, to, data, value: "0x0" }, r.blockNumber, errors);
  return settle(chain, label, hash, r, reason);
}

// ---- the stack ----

/** A stamp in the stack: its time, its digest, the owner's signature once added, and its relay once mined, or the relay
 * of a later stamp that covered it while both were due (the clock moves to the latest, so it was never sent). */
export interface StackedStamp {
  asOf: string;
  digest: Hex;
  sig: Hex | null;
  relayed?: { hash: Hex; block: number };
  coveredBy?: Hex;
}

/** ops/stamps/<chain>.json: one deployment's contract's stamps, dated from its chain's head. */
export interface StampStack {
  version: 1;
  deployment: string;
  target: "live" | "rehearsal";
  chain: ChainName;
  chainId: number;
  contract: Address;
  stamps: StackedStamp[];
}

/** The times of a stack of `days` days from the head time `head`: head, head + `everyHours`, … (STAMP_SPACING_HOURS, 12,
 * by default; a wider spacing only with `acceptGapRisk`, stackBoundsProblem). */
export function stackAsOfs(head: bigint, days: number, everyHours = STAMP_SPACING_HOURS, acceptGapRisk?: string): bigint[] {
  const problem = stackBoundsProblem(days, everyHours, acceptGapRisk);
  if (problem) throw new Error(problem);
  const every = BigInt(everyHours) * 3_600n;
  return Array.from({ length: (days * 24) / everyHours }, (_, i) => head + BigInt(i) * every);
}

/** The stamps due at the head time `head`, newest first: signed, not relayed nor covered yet, as of `head` or before
 * it, and at least EXPIRY_MARGIN from expiring, so the block that takes the relay is still in the window. Never one from
 * the future of the head. */
export function dueStamps(stack: Pick<StampStack, "stamps">, head: bigint): StackedStamp[] {
  return stack.stamps
    .filter((s) => s.sig !== null && !s.relayed && !s.coveredBy && BigInt(s.asOf) <= head && BigInt(s.asOf) + STAMP_MAX_TTL - head >= EXPIRY_MARGIN)
    .sort((a, b) => (BigInt(a.asOf) > BigInt(b.asOf) ? -1 : 1));
}

export const stackPath = (dir: string, chain: ChainName) => join(dir, `${chain}.json`);

function loadStack(path: string): StampStack | null {
  if (!existsSync(path)) return null;
  const s = JSON.parse(readFileSync(path, "utf8")) as StampStack;
  if (s.version !== 1 || !Array.isArray(s.stamps)) throw new Error(`${path} is not a stack of stamps (version 1); nothing read`);
  return s;
}

function saveStack(path: string, s: StampStack): void {
  s.stamps.sort((a, b) => (BigInt(a.asOf) < BigInt(b.asOf) ? -1 : 1));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---- the command ----

/** The two scheduler contracts a stamp is for. */
export type StampTarget = "vault" | "frontDoor";
const CHAIN: Record<StampTarget, ChainName> = { vault: "bittensor", frontDoor: "base" };
const CLI_NAME: Record<StampTarget, string> = { vault: "vault", frontDoor: "front-door" };
const LABEL: Record<StampTarget, string> = { vault: "vault", frontDoor: "front door" };

export interface StampOpts extends BuildsOpt {
  /** --accept-gap-risk: the reason a spacing above STAMP_SPACING_HOURS is accepted (printed with the risk). */
  acceptGapRisk?: string;
  /** prepare: write what the owner signs, as of each head; relay: one signed stamp now; toStack: add a signed stamp to
   * the stack; stack: write the stack's times, as of each head; relayDue: relay what the stack holds that is due. */
  mode: "prepare" | "relay" | "toStack" | "stack" | "relayDue";
  targets: StampTarget[];
  asOf?: bigint;
  sig?: string;
  days?: number;
  everyHours?: number;
  tipGwei?: bigint;
  /** The relayer's keystore and password file, by path (relayerFromEnv): relay and relayDue. */
  relayer?: { keystore: string; passwordFile: string };
  /** ops/stamps: the stacks, and sign/ for the typed data to sign. */
  dir: string;
  /** The deployment's name. */
  name: string;
  /** prepare and stack: where the stamps are written as a file for the sign page (Task 49); none written without it. */
  walletDir?: string;
  /** When that file is made, in ms (Date.now() by default). */
  now?: number;
}

/** The most stamps one file for the sign page holds (wallet.ts parses no more). */
const STAMPS_A_FILE = 120;

export interface StampResult {
  ok: boolean;
  lines: string[];
  files: string[];
  sent: Sent[];
}

/** The relayer's keystore and password file from OPS_RELAYER_KEYSTORE and OPS_RELAYER_PASSWORD_FILE, by path only: both
 * must be set. Throws naming each one missing. Reads no file. */
export function relayerFromEnv(env: Env): { keystore: string; passwordFile: string } {
  const problems: string[] = [];
  const get = (name: string) => {
    const v = env[name]?.trim() ?? "";
    if (!v) problems.push(`${name} is not set`);
    return v;
  };
  const r = { keystore: get("OPS_RELAYER_KEYSTORE"), passwordFile: get("OPS_RELAYER_PASSWORD_FILE") };
  if (problems.length) throw new Error(`the relayer's key is not named:\n  ${problems.join("\n  ")}\nthe relayer is a fresh key of its own (cast wallet new), never the Ledger's; nothing sent`);
  return r;
}

/** The relayer as a signer: the account its keystore opens as (cast wallet address, the password by file). */
async function relayerSigner(ctx: Ctx, key: StampOpts["relayer"]): Promise<Signer> {
  if (!key) throw new Error("the relayer's keystore is not named (OPS_RELAYER_KEYSTORE and OPS_RELAYER_PASSWORD_FILE); nothing sent");
  const address = await signingAccount(ctx, key);
  if (!address) throw new Error("the relayer's keystore (OPS_RELAYER_KEYSTORE) does not open with its password file; nothing sent");
  return { address: getAddress(address), keystore: key.keystore, passwordFile: key.passwordFile, name: "the relayer" };
}

/** `get()`, or the refusal that it could not be read now, saying what was not done (`nothing`). */
async function readNow<T>(what: string, get: () => Promise<T>, nothing: string): Promise<T> {
  try {
    return await get();
  } catch (e) {
    throw new Error(`Couldn't read ${what} right now (${firstLine(e)}); try again; ${nothing}`);
  }
}

const readOf = (c: StampTarget, ctx: Pick<Ctx, "rpc">, rec: RecordV32, fn: "guardian" | "keeper" | "owner" | "lastOwnerClose" | "DOMAIN_SEPARATOR" | "STAMP_TYPEHASH", o: BuildsOpt) =>
  c === "vault" ? readVault(ctx, rec, fn, [], o.buildsDir) : readDoor(ctx, rec, fn, [], o.buildsDir);

/** The accounts the relayer must not be, for relayStamp's `ledger` (besides the owner relayStamp reads itself): the
 * Ledger's ops knows, the guardian the contract names now and the plan's owner, guardian and treasury; and the keys with
 * a job of their own, the keeper the contract names now, the plan's keeper, v3-launch's keeper, the plan's deployers and
 * the test wallet (Task 48's review, M2). */
export async function relayerRefusals(ctx: Pick<Ctx, "rpc">, rec: RecordV32, c: StampTarget, o: BuildsOpt = {}): Promise<RefusedAccount[]> {
  const read = (fn: "guardian" | "keeper") => readNow(`${where(c)}'s ${fn}`, () => readOf(c, ctx, rec, fn, o), "nothing sent");
  const guardian = getAddress((await read("guardian")) as Address);
  const keeper = getAddress((await read("keeper")) as Address);
  const r = rec.plan.roles;
  const d = rec.plan.deployers;
  return [
    { name: "the guardian", address: guardian, ledger: true },
    { name: "the keeper", address: keeper, ledger: false },
    { name: "the plan's owner", address: r.owner, ledger: true },
    { name: "the plan's guardian", address: r.guardian, ledger: true },
    { name: "the treasury", address: r.treasury, ledger: true },
    { name: "the plan's keeper", address: r.keeper, ledger: false },
    { name: "v3-launch's keeper", address: V3_LAUNCH_KEEPER, ledger: false },
    { name: "the Base deployer", address: d.base, ledger: false },
    { name: "the Bittensor deployer", address: d.bittensor, ledger: false },
    { name: "the test wallet", address: WALLET, ledger: false },
  ];
}

/** Before the owner is asked to sign: the contract's DOMAIN_SEPARATOR and STAMP_TYPEHASH (through its lens) must be the
 * ones ops hashes with, or a stamp signed for it would be over the wrong hash. */
async function checkDomain(ctx: Ctx, rec: RecordV32, c: StampTarget, o: BuildsOpt): Promise<void> {
  const chainId = chainIdFor(rec, CHAIN[c]);
  const contract = getAddress(rec.plan.addresses[c]);
  const want = stampHashes(chainId, contract, 0n).domainHash;
  const got = (await readNow(`${where(c)}'s DOMAIN_SEPARATOR`, () => readOf(c, ctx, rec, "DOMAIN_SEPARATOR", o), "nothing to sign")) as Hex;
  if (!same(got, want)) {
    throw new Error(`${where(c)}'s DOMAIN_SEPARATOR is ${got}, not ${want}, the one ops computes for chain ${chainId} and ${contract}: a stamp signed for it would be over the wrong hash; nothing to sign`);
  }
  const type = (await readNow(`${where(c)}'s STAMP_TYPEHASH`, () => readOf(c, ctx, rec, "STAMP_TYPEHASH", o), "nothing to sign")) as Hex;
  if (!same(type, STAMP_TYPEHASH)) throw new Error(`${where(c)}'s STAMP_TYPEHASH is ${type}, not keccak256("OwnerStamp(uint64 asOf)"): a stamp signed for it would be over the wrong hash; nothing to sign`);
}

/** The stack's own record of what it is for must be this deployment's contract. */
function stackProblem(path: string, s: StampStack, rec: RecordV32, c: StampTarget, name: string): string | null {
  const chainId = chainIdFor(rec, CHAIN[c]);
  const contract = getAddress(rec.plan.addresses[c]);
  if (s.deployment === name && s.target === rec.target && s.chain === CHAIN[c] && s.chainId === chainId && same(s.contract, contract)) return null;
  return `${path} is for contract ${getAddress(s.contract)} on chain ${s.chainId} of ${s.deployment} (${s.target}), not this deployment's ${LABEL[c]} ${contract} on chain ${chainId} of ${name} (${rec.target})`;
}

/** `pnpm ops stamp`: one run of the modes StampOpts names. Reads only, but relay and relayDue, which send from the relayer. */
export async function stampCommand(ctx: Ctx, rec: RecordV32, o: StampOpts): Promise<StampResult> {
  switch (o.mode) {
    case "prepare":
      return prepare(ctx, rec, o);
    case "relay":
      return relayOne(ctx, rec, o);
    case "toStack":
    case "stack":
    case "relayDue": {
      // one writer of the stacks at a time: a bot's relay-due and a hand-run addition never overwrite each other
      mkdirSync(o.dir, { recursive: true });
      const release = takeRunLock(join(o.dir, "stamps.lock"), { log: ctx.log, what: "stamp run" });
      try {
        return o.mode === "toStack" ? await toStack(ctx, rec, o) : o.mode === "stack" ? await stack(ctx, rec, o) : await relayDue(ctx, rec, o);
      } finally {
        release();
      }
    }
  }
}

const live = (ctx: Ctx) => (ctx.live ? " --live" : "");

/** The owner each target names now, who signs its stamps on the sign page: read only for a file for it, which is
 * written for a live deployment alone (the page signs only on Base and Bittensor EVM, never the forks). */
async function ownersOf(ctx: Ctx, rec: RecordV32, o: StampOpts, nothing: string): Promise<Partial<Record<StampTarget, Address>>> {
  const out: Partial<Record<StampTarget, Address>> = {};
  if (!o.walletDir || rec.target !== "live") return out;
  for (const c of o.targets) out[c] = getAddress((await readNow(`${where(c)}'s owner`, () => readOf(c, ctx, rec, "owner", o), nothing)) as Address);
  return out;
}

/** The stamps written as files for the sign page, at most STAMPS_A_FILE each, and the lines that say so. */
function writeStampFiles(o: StampOpts, stem: string, title: (n: number) => string, stamps: StampRequest[], then: (n: number) => string): { files: string[]; lines: string[] } {
  const out = { files: [] as string[], lines: [] as string[] };
  if (!o.walletDir || !stamps.length) return out;
  const parts = Math.ceil(stamps.length / STAMPS_A_FILE);
  for (let k = 0; k < parts; k++) {
    const chunk = stamps.slice(k * STAMPS_A_FILE, (k + 1) * STAMPS_A_FILE);
    const path = writeWalletFile(o.walletDir, parts === 1 ? stem : `${stem}-${k + 1}`, walletFile({ title: title(chunk.length), deployment: o.name, now: o.now ?? Date.now(), calls: [], stamps: chunk }));
    out.files.push(path);
    out.lines.push(wroteStampsLine(path, chunk.length, then(chunk.length)));
  }
  return out;
}

/** What the owner signs now: each contract's stamp as of its chain's head, its typed data written to sign/, and the
 * hashes the Ledger shows; with a wallet folder, the stamps also as a file for the sign page, which relays each once it
 * is signed. */
async function prepare(ctx: Ctx, rec: RecordV32, o: StampOpts): Promise<StampResult> {
  await checkChains(ctx, o.targets.map((c) => CHAIN[c]));
  for (const c of o.targets) await checkDomain(ctx, rec, c, o);
  const owners = await ownersOf(ctx, rec, o, "nothing to sign");
  const lines: string[] = [];
  const files: string[] = [];
  const requests: StampRequest[] = [];
  for (const c of o.targets) {
    const chain = CHAIN[c];
    const chainId = chainIdFor(rec, chain);
    const contract = getAddress(rec.plan.addresses[c]);
    const asOf = await readNow(`${chainLabel(chain)}'s head`, () => headTime(ctx, chain), "nothing to sign");
    const h = stampHashes(chainId, contract, asOf);
    const dir = join(o.dir, "sign");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${o.name}-${chain}-${asOf}.json`);
    writeFileSync(path, `${JSON.stringify(stampTypedDataJson(chainId, contract, asOf), null, 2)}\n`);
    files.push(path);
    lines.push(
      `${chainLabel(chain)} ${LABEL[c]} ${contract} (chain ${chainId}): the owner's stamp as of ${asOf} (${isoOf(asOf)}), ${chainLabel(chain)}'s head time.`,
      `  To compare on the Ledger: domain hash ${h.domainHash}, message hash ${h.structHash}, digest ${h.digest}.`,
      `  Wrote ${path}. Have the owner's Ledger sign it, then within a day: pnpm ops stamp ${CLI_NAME[c]} --as-of ${asOf} --sig <the signature>${live(ctx)}`,
    );
    const owner = owners[c];
    if (owner) requests.push({ chainId, contract, asOf: asOf.toString(), from: owner, mode: "relay", label: `the owner's stamp as of ${asOf} on the ${LABEL[c]} (${chainLabel(chain)})` });
  }
  const page = writeStampFiles(
    o,
    `${o.name}-stamp-${requests[0]?.asOf}`,
    (n) => `Cascade ${o.name}: the owner's stamp${n === 1 ? " as of its chain's head" : "s as of each chain's head"}, to relay at once`,
    requests,
    (n) => `relays ${n === 1 ? "it" : "each"} at once from the relayer`,
  );
  return { ok: true, lines: [...lines, ...page.lines], files: [...files, ...page.files], sent: [] };
}

/** One signed stamp relayed now, from the relayer; the owner's clock read back after it. */
async function relayOne(ctx: Ctx, rec: RecordV32, o: StampOpts): Promise<StampResult> {
  const [c] = o.targets;
  if (o.targets.length !== 1 || o.asOf === undefined || o.sig === undefined) throw new Error("a relay is one contract's stamp: its --as-of and --sig; nothing sent");
  const chain = CHAIN[c];
  const contract = getAddress(rec.plan.addresses[c]);
  const relayer = await relayerSigner(ctx, o.relayer);
  // the live gate and the chain id before anything is read there
  await gate(ctx, chain);
  const ledger = await relayerRefusals(ctx, rec, c, o);
  const errors = buildErrorsV32(loadBuildV32(rec.build, o.buildsDir));
  const sent = await relayStamp({ ...ctx, signer: relayer }, chain, contract, o.asOf, o.sig as Hex, { tipGwei: o.tipGwei, ledger, errors });
  return { ok: true, lines: [await relayedLine(ctx, rec, c, o, o.asOf, sent)], files: [], sent: [sent] };
}

async function relayedLine(ctx: Ctx, rec: RecordV32, c: StampTarget, o: BuildsOpt, asOf: bigint, sent: Sent): Promise<string> {
  const head = `${chainLabel(CHAIN[c])} ${LABEL[c]} ${getAddress(rec.plan.addresses[c])}: stamped as of ${isoOf(asOf)} (transaction ${sent.hash}).`;
  try {
    const clock = BigInt((await readOf(c, ctx, rec, "lastOwnerClose", o)) as bigint);
    return `${head} The owner's clock reads ${isoOf(clock)}: every item scheduled there at or before then is dead.`;
  } catch (e) {
    return `${head} The owner's clock could not be read back (${firstLine(e)}).`;
  }
}

/** The line that says how long the stack keeps the founder's own items from surviving. */
const lastLine = (chain: ChainName, last: bigint) =>
  `  The last stamp is as of ${isoOf(last)}: anything scheduled on ${chainLabel(chain)} at or before then dies to it. Schedule what you mean to keep after that.`;

/** The stack's times as of each head: kept, every signed stamp still in its window (signed, it binds) and every time of
 * the new stack; dropped, expired ones and unsigned times of an older stack. */
async function stack(ctx: Ctx, rec: RecordV32, o: StampOpts): Promise<StampResult> {
  const every = o.everyHours ?? STAMP_SPACING_HOURS;
  const bounds = stackBoundsProblem(o.days ?? 0, every, o.acceptGapRisk);
  if (bounds) throw new Error(`${bounds}; nothing read or written`);
  await checkChains(ctx, o.targets.map((c) => CHAIN[c]));
  for (const c of o.targets) await checkDomain(ctx, rec, c, o);
  const owners = await ownersOf(ctx, rec, o, "nothing written");
  // every chain's stack is read and checked before any is written: a refusal writes nothing (Task 48's review, M4)
  const planned: { c: StampTarget; path: string; head: bigint; s: StampStack }[] = [];
  for (const c of o.targets) {
    const chain = CHAIN[c];
    const chainId = chainIdFor(rec, chain);
    const contract = getAddress(rec.plan.addresses[c]);
    const head = await readNow(`${chainLabel(chain)}'s head`, () => headTime(ctx, chain), "nothing written");
    const times = stackAsOfs(head, o.days ?? 0, every, o.acceptGapRisk);
    const path = stackPath(o.dir, chain);
    const old = loadStack(path);
    if (old) {
      const p = stackProblem(path, old, rec, c, o.name);
      if (p) throw new Error(`${p}: move it away first; nothing written`);
    }
    const kept = (old?.stamps ?? []).filter((x) => x.sig !== null && head - BigInt(x.asOf) < STAMP_MAX_TTL);
    const have = new Set(kept.map((x) => x.asOf));
    const fresh = times.filter((t) => !have.has(t.toString())).map((t): StackedStamp => ({ asOf: t.toString(), digest: stampHashes(chainId, contract, t).digest, sig: null }));
    planned.push({ c, path, head, s: { version: 1, deployment: o.name, target: rec.target, chain, chainId, contract, stamps: [...kept, ...fresh] } });
  }
  const lines: string[] = [];
  const files: string[] = [];
  if (o.acceptGapRisk !== undefined) lines.push(gapRiskLine(every, o.acceptGapRisk));
  mkdirSync(o.dir, { recursive: true });
  for (const { c, path, head, s } of planned) {
    const chain = CHAIN[c];
    saveStack(path, s);
    files.push(path);
    const toSign = s.stamps.filter((x) => x.sig === null);
    const last = s.stamps.reduce((m, x) => (BigInt(x.asOf) > m ? BigInt(x.asOf) : m), 0n);
    lines.push(
      `${chainLabel(chain)} ${LABEL[c]} ${s.contract} (chain ${s.chainId}): wrote ${path}, ${toSign.length} stamps to sign, every ${every} hours from ${chainLabel(chain)}'s head (${isoOf(head)}):`,
    );
    for (const x of toSign) lines.push(`  as of ${x.asOf} (${isoOf(BigInt(x.asOf))}): digest ${x.digest}`);
    lines.push(`  Have the owner's Ledger sign each, then add it: pnpm ops stamp ${CLI_NAME[c]} --as-of <time> --sig <the signature> --to-stack${live(ctx)}`, lastLine(chain, last));
  }
  // with a wallet folder, every stamp still to sign as a file for the sign page, which adds each to its stack once signed
  const requests = planned.flatMap(({ c, s }) => {
    const owner = owners[c];
    if (!owner) return [];
    return s.stamps
      .filter((x) => x.sig === null)
      .map((x): StampRequest => ({ chainId: s.chainId, contract: s.contract, asOf: x.asOf, from: owner, mode: "stack", label: `the stack's stamp as of ${x.asOf} on the ${LABEL[c]} (${chainLabel(CHAIN[c])})` }));
  });
  const page = writeStampFiles(o, `${o.name}-stack-${planned[0]?.head}`, (n) => `Cascade ${o.name}: the stack's ${n} stamp${n === 1 ? "" : "s"} to sign`, requests, (n) => `adds ${n === 1 ? "it" : "each"} to its stack`);
  return { ok: true, lines: [...lines, ...page.lines], files: [...files, ...page.files], sent: [] };
}

/** Why --to-stack would refuse the stamp as of `asOf` for `c` before any signature is looked at, or null: no stack at
 * `dir`, a stack of another deployment, contract or chain, a time that isn't one of the stack's, or another digest for it
 * than ops computes. The sign page asks this when it is served (Task 49's review, M2), so it offers no stamp the stack
 * would refuse. */
export function stackEntryProblem(dir: string, rec: RecordV32, c: StampTarget, name: string, asOf: bigint): string | null {
  const chain = CHAIN[c];
  const path = stackPath(dir, chain);
  const s = loadStack(path);
  if (!s) return `no stack at ${path}: write one with pnpm ops stamp --stack <days>`;
  const p = stackProblem(path, s, rec, c, name);
  if (p) return p;
  const entry = s.stamps.find((x) => BigInt(x.asOf) === asOf);
  if (!entry) return `${asOf} is not one of the times in ${path}: sign one of its stamps, or write a new stack with --stack <days>`;
  const digest = stampHashes(chainIdFor(rec, chain), getAddress(rec.plan.addresses[c]), asOf).digest;
  if (!same(digest, entry.digest)) return `${path} holds another digest for ${asOf} than ops computes: it is not this contract's stack`;
  return null;
}

/** A signed stamp added to its stack: one of the stack's times, signed by the owner the contract names now, not expired. */
async function toStack(ctx: Ctx, rec: RecordV32, o: StampOpts): Promise<StampResult> {
  const [c] = o.targets;
  if (o.targets.length !== 1 || o.asOf === undefined || o.sig === undefined) throw new Error("--to-stack adds one contract's stamp: its --as-of and --sig; nothing added");
  const chain = CHAIN[c];
  const problem = stackEntryProblem(o.dir, rec, c, o.name, o.asOf);
  if (problem) throw new Error(`${problem}; nothing added`);
  const path = stackPath(o.dir, chain);
  const s = loadStack(path) as StampStack;
  const entry = s.stamps.find((x) => BigInt(x.asOf) === o.asOf) as StackedStamp;
  const sig = normaliseSignature(o.sig);
  const owner = getAddress((await readNow(`${where(c)}'s owner`, () => readOf(c, ctx, rec, "owner", o), "nothing added")) as Address);
  const digest = entry.digest;
  await mustBeTheOwners(digest, sig, owner, `the stamp as of ${o.asOf} on ${chainLabel(chain)}`, "nothing added");
  const head = await readNow(`${chainLabel(chain)}'s head`, () => headTime(ctx, chain), "nothing added");
  if (head - o.asOf >= STAMP_MAX_TTL) throw new Error(`the stamp as of ${o.asOf} (${isoOf(o.asOf)}) has expired by ${chainLabel(chain)}'s head (${isoOf(head)}): sign a later one; nothing added`);
  // the contract's own answer (Task 48's review, M6): it checks the signer before the window, against its immutable
  // DOMAIN_SEPARATOR, so a good signature runs (a stamp due now) or answers StampOutOfWindow (one for later), and one
  // over any other hash answers BadStamp, on the day it is signed rather than the day it falls due
  const data = encodeFunctionData({ abi: STAMP_ABI, functionName: "stampBySig", args: [o.asOf, sig] });
  const a = await ask(ctx, chain, { from: owner, to: getAddress(rec.plan.addresses[c]), data }, buildErrorsV32(loadBuildV32(rec.build, o.buildsDir)));
  if (a.kind === "unread") throw new Error(`Couldn't check stampBySig(${o.asOf}) on ${where(c)} right now (the RPC did not run it: ${a.why}); try again; nothing added`);
  if (a.kind === "reverted" && a.name === "BadStamp") {
    throw new Error(`${where(c)} answers BadStamp() to this signature by eth_call: it is not over the contract's own hash, so it would never stamp; nothing added`);
  }
  if (a.kind === "reverted" && a.name !== "StampOutOfWindow") throw new Error(`stampBySig(${o.asOf}) on ${where(c)} would revert: ${a.error}; nothing added`);
  entry.sig = sig;
  saveStack(path, s);
  const signed = s.stamps.filter((x) => x.sig !== null);
  const last = signed.reduce((m, x) => (BigInt(x.asOf) > m ? BigInt(x.asOf) : m), 0n);
  return {
    ok: true,
    lines: [`${chainLabel(chain)} ${LABEL[c]}: added the stamp as of ${isoOf(o.asOf)} to ${path} (${signed.length} of ${s.stamps.length} signed).`, lastLine(chain, last)],
    files: [path],
    sent: [],
  };
}

/** The sign page's hand-off of a stamp the owner's Ledger signed there (Task 49; its review's M3), as pnpm ops sign
 * passes it to the page (v32/sign.ts SignV32Deps.stamps): `ready` names the relayer's key (OPS_RELAYER_KEYSTORE and
 * OPS_RELAYER_PASSWORD_FILE, by path) before the page is served, for a stamp to relay; `submit` runs this command's relay
 * (relayOne: the relayer refused when it is an account of the Ledger or a key with a job of its own, the signature the
 * owner's, the window, stampBySig asked by eth_call, then sent from the relayer) or --to-stack (the stack's file only,
 * nothing sent, no relayer opened). `dir` is the stacks' folder. */
export function signPageStamps(ctx: Ctx, env: Env, o: { dir: string; name: string; buildsDir?: string }) {
  return {
    dir: o.dir,
    ready: async (mode: "relay" | "stack"): Promise<void> => {
      if (mode === "relay") relayerFromEnv(env);
    },
    submit: async (rec: RecordV32, s: { target: StampTarget; asOf: bigint; sig: Hex; mode: "relay" | "stack" }): Promise<StampResult> =>
      stampCommand(ctx, rec, {
        mode: s.mode === "relay" ? "relay" : "toStack",
        targets: [s.target],
        asOf: s.asOf,
        sig: s.sig,
        ...(s.mode === "relay" ? { relayer: relayerFromEnv(env) } : {}),
        dir: o.dir,
        name: o.name,
        ...(o.buildsDir ? { buildsDir: o.buildsDir } : {}),
      }),
  };
}

/** What the bot runs: each stack's newest due stamp relayed (the next newest if it fails), recorded in the file once
 * mined with the older due ones it covers; what it couldn't relay, and a stack with less than 2 days left, said. Not ok
 * (a line says so) when a relay fails, a stamp left its window unrelayed or was due unsigned, a stack is missing or not
 * this deployment's, or the stack holds no signed stamp after the head (it has run out). */
async function relayDue(ctx: Ctx, rec: RecordV32, o: StampOpts): Promise<StampResult> {
  const lines: string[] = [];
  const sent: Sent[] = [];
  let ok = true;
  const errors = buildErrorsV32(loadBuildV32(rec.build, o.buildsDir));
  for (const c of o.targets) {
    const chain = CHAIN[c];
    const at = `${chainLabel(chain)} ${LABEL[c]}`;
    const path = stackPath(o.dir, chain);
    try {
      const s = loadStack(path);
      if (!s) {
        ok = false;
        lines.push(`${at}: no stack at ${path}: write one with pnpm ops stamp --stack <days>.`);
        continue;
      }
      const p = stackProblem(path, s, rec, c, o.name);
      if (p) {
        ok = false;
        lines.push(`${at}: ${p}; nothing relayed`);
        continue;
      }
      await gate(ctx, chain);
      const head = await headTime(ctx, chain);
      const due = dueStamps(s, head);
      // the newest due stamp is relayed first: it covers the older ones, since the clock moves to the latest, so they are
      // not sent; a failed relay falls back to the next newest (Task 48's review, M5)
      let who: { relayer: Signer; ledger: RefusedAccount[] } | undefined;
      for (const [i, d] of due.entries()) {
        const asOf = BigInt(d.asOf);
        try {
          who ??= { relayer: await relayerSigner(ctx, o.relayer), ledger: await relayerRefusals(ctx, rec, c, o) };
          const done = await relayStamp({ ...ctx, signer: who.relayer }, chain, s.contract, asOf, d.sig as Hex, { tipGwei: o.tipGwei, ledger: who.ledger, errors, label: `the stamp as of ${isoOf(asOf)}` });
          d.relayed = { hash: done.hash, block: done.block };
          const older = due.slice(i + 1);
          for (const x of older) x.coveredBy = done.hash;
          saveStack(path, s);
          sent.push(done);
          lines.push(`${at}: relayed the stamp as of ${isoOf(asOf)} (transaction ${done.hash}).`);
          if (older.length) {
            lines.push(
              `${at}: ${older.length} older due stamp${older.length === 1 ? "" : "s"} (as of ${older.map((x) => isoOf(BigInt(x.asOf))).join(", ")}) not sent: the stamp as of ${isoOf(asOf)} covers ${older.length === 1 ? "it" : "them"}.`,
            );
          }
          break;
        } catch (e) {
          ok = false;
          lines.push(`${at}: the stamp as of ${isoOf(asOf)} was not relayed: ${firstLine(e)}`);
        }
      }
      const next = s.stamps
        .filter((x) => x.sig !== null && !x.relayed && BigInt(x.asOf) > head)
        .map((x) => BigInt(x.asOf))
        .sort((a, b) => (a < b ? -1 : 1));
      if (!due.length) lines.push(`${at}: nothing due now (head time ${isoOf(head)})${next.length ? `; the next is due at ${isoOf(next[0])}` : ""}.`);
      // the newest stamp relayed so far: the owner's clock is at least its asOf
      const lastRelayed = s.stamps.filter((x) => x.relayed).reduce((m, x) => (BigInt(x.asOf) > m ? BigInt(x.asOf) : m), -1n);
      for (const x of s.stamps) {
        const asOf = BigInt(x.asOf);
        const age = head - asOf;
        // a stamp that left its window unrelayed in the last day (the bot was down, or a relay failed), or that was due
        // and never signed: each a gap the bot's alarm must show (Task 48's review, M3). A missed stamp a later relayed one
        // covers (the clock moved past its asOf, so it kills all the missed one would) is said, and fails nothing (Task
        // 48's re-review, N2): the defence is whole again
        if (x.sig !== null && !x.relayed && !x.coveredBy && age > STAMP_MAX_TTL - EXPIRY_MARGIN && age < 2n * STAMP_MAX_TTL) {
          if (lastRelayed > asOf) {
            lines.push(`${at}: the stamp as of ${isoOf(asOf)} was not relayed in its window; the stamp as of ${isoOf(lastRelayed)}, relayed since, covers it.`);
          } else {
            ok = false;
            lines.push(`  WARNING — ${at}: the stamp as of ${isoOf(asOf)} was not relayed in its window.`);
          }
        }
        if (x.sig === null && asOf <= head && age < STAMP_MAX_TTL) {
          ok = false;
          lines.push(`  WARNING — ${at}: the stamp as of ${isoOf(asOf)} is due but not signed.`);
        }
      }
      const lastSigned = s.stamps.filter((x) => x.sig !== null).reduce((m, x) => (BigInt(x.asOf) > m ? BigInt(x.asOf) : m), 0n);
      // the lead time for the founder's next Ledger session
      if (next.length && lastSigned - head < LEAD_TIME) {
        lines.push(`  WARNING — ${at}: the stack has less than 2 days left: its last stamp is as of ${isoOf(lastSigned)}. Write and sign a new stack before then.`);
      }
      // the stack runs out: no signed stamp after the head
      if (!next.length) {
        ok = false;
        const last = s.stamps.filter((x) => x.sig !== null).reduce((m, x) => (BigInt(x.asOf) > m ? BigInt(x.asOf) : m), 0n);
        lines.push(
          last
            ? `  WARNING — ${at}: the stack's last stamp is as of ${isoOf(last)}: write and sign a new stack before ${isoOf(last + STAMP_MAX_TTL)}, or items scheduled after it survive.`
            : `  WARNING — ${at}: the stack holds no signed stamp: sign its stamps (--to-stack), or items scheduled now survive.`,
        );
      }
    } catch (e) {
      ok = false;
      lines.push(`${at}: couldn't read its stack or its chain (${firstLine(e)}); nothing relayed.`);
    }
  }
  if (!ok) lines.push("This run fails: see the lines above.");
  return { ok, lines, files: [], sent };
}
