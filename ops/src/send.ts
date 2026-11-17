import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  decodeErrorResult,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  type Hex,
  hexToBigInt,
  hexToNumber,
  keccak256,
  numberToHex,
  parseSignature,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  type Signature,
  serializeTransaction,
  type TransactionSerializable,
  toFunctionSignature,
} from "viem";
import { PREAUDIT_CONTRACTS, preauditArtifact } from "./builds.ts";
import { type ChainName, type ChainTarget, gweiOf, type Paths, WALLET } from "./config.ts";
import { chainLabel, ReceiptTimeout, RevertedOnChain, SendRefused, unit } from "./keeper/core/errors.ts";
import type { Replacement, Sent } from "./keeper/core/types.ts";
import { chainIdOf, codeAt, gasPriceOf, isRevert, nonceOf, priorityFeeOf, type Rpc, RpcError } from "./rpc.ts";
import type { CallRequest, CreateRequest, CreateRequestV32 } from "./types.ts";
import { buildErrorsV32, deployDataV32 } from "./v32/build.ts";

export interface Runner {
  run(file: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Runs Foundry without a shell, so no argument is ever re-parsed. */
export const execFileRunner: Runner = {
  run: (file, args, opts) =>
    new Promise((resolve) =>
      execFile(file, args, { cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
      ),
    ),
};

export interface Ctx {
  live: boolean;
  targets: Record<ChainName, ChainTarget>;
  rpc: Rpc;
  /** Where log scans go (rpc.ts logsRpc): the live tools' own Base logs server. Absent = `rpc` (the
   * local forks, and tests). Every eth_getLogs, and the head a scan reads first, goes through logsOf. */
  logs?: Rpc;
  /** The block range one eth_getLogs asks `logs` for, per chain: the live Base logs server's own
   * (OPS_BASE_LOGS_WINDOW). Absent = WINDOW (keeper/state.ts), what any public RPC accepts. */
  logsWindow?: Partial<Record<ChainName, bigint>>;
  /** The highest gas price a send goes out at, per chain, in wei (config.ts maxGasPrices): over it the
   * send is refused ("fee") and tried again later. Absent = no cap (tests, the local forks). */
  maxGasPrice?: Partial<Record<ChainName, bigint>>;
  /** Who sends: absent = the test wallet with paths.keystore (every command but pause and unpause). */
  signer?: Signer;
  runner: Runner;
  paths: Paths;
  log(line: string): void;
  receiptTimeoutMs: number;
  pollMs?: number;
}

// The keeper core's send errors, labels and types (one class each, so `instanceof` holds whichever module threw it).
export { chainLabel, type RefusalReason, ReceiptTimeout, RevertedOnChain, SendRefused, scrubSecrets, unit } from "./keeper/core/errors.ts";
export { logsOf } from "./keeper/core/logs.ts";
export type { Replacement, Sent } from "./keeper/core/types.ts";

/** A v3.2 create was mined but did not leave what the plan predicts: its receipt names no contract or another address.
 * The plan's addresses no longer hold. */
export class UnexpectedReceipt extends Error {}

/** A v3.2 create's receipt is good (status 1, the planned address) but the RPC shows no code there yet: most likely a
 * node a few blocks behind. `sent` is the receipt's record; the next run compares the code with the build. */
export class CodeNotYetSeen extends Error {
  readonly sent: Sent;

  constructor(message: string, sent: Sent) {
    super(message);
    this.sent = sent;
  }
}

/** An account the tool signs as: its address, its Foundry keystore and password file (by path only), and
 * how messages name it. */
export interface Signer {
  address: Address;
  keystore: string;
  passwordFile: string;
  name: string;
}

/** The context's signer, else the test wallet with the default keystore. */
export const signerOf = (ctx: Pick<Ctx, "signer" | "paths">): Signer =>
  ctx.signer ?? { address: WALLET, keystore: ctx.paths.keystore, passwordFile: ctx.paths.passwordFile, name: "the test wallet" };

/** One argument as cast and forge parse it: tuples (a,b), arrays [a,b], integers in decimal. */
export function castArg(value: unknown, param: AbiParameter): string {
  const array = param.type.match(/^(.*)\[\d*\]$/);
  if (array) {
    const inner = { ...param, type: array[1] } as AbiParameter;
    return `[${(value as unknown[]).map((v) => castArg(v, inner)).join(",")}]`;
  }
  if (param.type === "tuple") {
    const components = (param as { components: readonly AbiParameter[] }).components;
    const values = Array.isArray(value) ? value : components.map((c) => (value as Record<string, unknown>)[c.name!]);
    return `(${components.map((c, i) => castArg(values[i], c)).join(",")})`;
  }
  if (param.type === "bool") return value ? "true" : "false";
  if (/^u?int\d*$/.test(param.type)) return BigInt(value as bigint).toString();
  return String(value);
}

const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes RPC addresses (which can carry an API key) from text we print: anything after each RPC's
 * origin, and any key-like query parameter. */
export function redact(targets: Ctx["targets"], text: string): string {
  let out = text;
  for (const t of Object.values(targets)) {
    const origin = new URL(t.rpcUrl).origin;
    // String.raw: in a plain template literal "\s" would lose its backslash and match only the letter s
    out = out.replace(new RegExp(String.raw`${escape(origin)}[^\s)"'\]]*`, "g"), `${origin}/…`);
  }
  return out.replace(/((?:d|api_?)?key|token|secret)=[^&\s)"']+/gi, "$1=…");
}

/** A URL's registrable domain, the last two labels of its host (drpc.org, publicnode.com): never a
 * subdomain, path or query, where a provider's key can sit. An IP address or a one-label host as it is.
 * (No public-suffix list: a host under e.g. co.uk shows as co.uk, which says less but leaks nothing.) */
export function hostDomain(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "an RPC that isn't a URL";
  }
  if (/^[\d.]+$/.test(host) || host.startsWith("[") || !host.includes(".")) return host;
  return host.split(".").slice(-2).join(".");
}

/** Which server the live tools read Base's logs from: its registrable domain only (a provider's key, in a
 * subdomain, path or query, never printed). */
export const baseLogsLine = (target: ChainTarget) => `Reading Base's logs from ${hostDomain(target.rpcUrl)} (set OPS_BASE_LOGS_RPC to change it)`;

const isLocal = (url: string) => ["127.0.0.1", "localhost"].includes(new URL(url).hostname);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A Foundry tool's path (forge, cast) in the configured Foundry bin. */
export const bin = (ctx: Pick<Ctx, "paths">, name: string) => join(ctx.paths.foundryBin, process.platform === "win32" ? `${name}.exe` : name);

/** The live gate and the chain id: before anything is estimated or signed (and, for a v3.2 deployment, before anything
 * is read: v32/deploy.ts). */
export async function gate(ctx: Ctx, chain: ChainName): Promise<void> {
  const local = Object.values(ctx.targets).every((t) => isLocal(t.rpcUrl));
  const remote = Object.values(ctx.targets).every((t) => !isLocal(t.rpcUrl));
  if (!ctx.live && !local) throw new SendRefused("not-live", "this command would reach the live networks: add --live to mean it");
  if (ctx.live && !remote) throw new SendRefused("not-live", "--live was given but an RPC points at this machine");
  const id = await chainIdOf(ctx.rpc, chain);
  if (id !== ctx.targets[chain].chainId) {
    throw new SendRefused("chain-id", `${chainLabel(chain)}: the RPC reports chain id ${id}, expected ${ctx.targets[chain].chainId}`);
  }
}

/** Live gate, chain id and nonce: all before anything is estimated. */
async function guard(ctx: Ctx, chain: ChainName, nonce: number): Promise<void> {
  await gate(ctx, chain);
  const from = signerOf(ctx);
  const current = await nonceOf(ctx.rpc, chain, from.address);
  const mined = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [from.address, "latest"])) as Hex);
  if (mined !== current) {
    throw new SendRefused(
      "waiting",
      `${chainLabel(chain)}: an earlier transaction from ${from.name} (nonce ${mined}) is still waiting to be mined; nothing sent — try again once it is`,
    );
  }
  if (current !== nonce) {
    throw new SendRefused("nonce", `${chainLabel(chain)}: the wallet's next nonce is ${current}, the plan expected ${nonce}`);
  }
}

/** The account a keystore signs as (Foundry's `cast wallet address`; the password by file only), or
 * undefined when it can't be opened. */
export async function signingAccount(ctx: Pick<Ctx, "runner" | "paths">, s: Pick<Signer, "keystore" | "passwordFile">): Promise<Address | undefined> {
  const out = await ctx.runner.run(bin(ctx as Ctx, "cast"), ["wallet", "address", "--keystore", s.keystore, "--password-file", s.passwordFile], {
    cwd: ctx.paths.contractsDir,
  });
  return out.code === 0 ? (out.stdout.match(/0x[0-9a-fA-F]{40}/)?.[0] as Address | undefined) : undefined;
}

const signerChecked = new WeakSet<Ctx>();

/** Once per run: the keystore must sign as the context's signer (the test wallet unless the context names
 * another), or a send would come from another account. */
async function checkSigner(ctx: Ctx): Promise<void> {
  if (signerChecked.has(ctx)) return;
  const s = signerOf(ctx);
  const signer = await signingAccount(ctx, s);
  if (!signer || signer.toLowerCase() !== s.address.toLowerCase()) {
    throw new SendRefused("signer", `the keystore signs as ${signer ?? "an unknown account"}, not ${s.name} ${s.address}; nothing sent`);
  }
  signerChecked.add(ctx);
}

let errorAbi: Abi | undefined;

/** The contracts' custom errors, so a failed estimate can say which one: v3-launch's frozen build's
 * (builds.ts), the build of every v3-launch plan this tool sends for; a v3.2 send names its own build's. */
function contractErrors(): Abi {
  errorAbi ??= PREAUDIT_CONTRACTS.flatMap((n) => preauditArtifact(n).abi.filter((i) => i.type === "error"));
  return errorAbi;
}

/** A failed call's reason: a Cascade contract's error by name (from `errors`, else v3-launch's), Error(string) with its
 * text (e.g. the router's "Too little received"), else the node's message. */
export function describeRevert(e: unknown, errors?: Abi): string {
  const raw = e instanceof RpcError ? e.data : undefined;
  const data = typeof raw === "string" ? raw : (raw as { data?: unknown } | undefined)?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: errors ?? contractErrors(), data: data as Hex });
      return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
    } catch {
      return `${(e as Error).message}, revert data ${data}`;
    }
  }
  return (e as Error).message;
}

/** eth_estimateGas on the node with no gas price (with one, the node checks the balance and refuses). */
async function estimate(ctx: Ctx, chain: ChainName, tx: { from: Address; to?: Address; data: Hex; value?: Hex }, label: string, errors?: Abi) {
  try {
    return hexToBigInt((await ctx.rpc.request(chain, "eth_estimateGas", [tx])) as Hex);
  } catch (e) {
    throw new SendRefused("estimate", `${chainLabel(chain)}: ${label} would fail, nothing sent (${describeRevert(e, errors)})`);
  }
}

/** Why `price`, what a transaction would pay a gas now, is over the chain's cap (Ctx.maxGasPrice); or
 * undefined, under it or with no cap. prepare and replaceCall both judge the effective price, so a fresh
 * send and a replacement agree: a fresh send's is the node's gas price (the base fee plus its suggested
 * tip, which cast's own fee cap sits over); a replacement's is its gas price on a legacy chain, else the
 * lower of its fee cap and the base fee plus its tip. A fee spike costs a wait, never the wallet's funds. */
function overCap(ctx: Pick<Ctx, "maxGasPrice">, chain: ChainName, price: bigint): string | undefined {
  const cap = ctx.maxGasPrice?.[chain];
  if (cap === undefined || price <= cap) return undefined;
  return `${chainLabel(chain)}: the gas price is ${gweiOf(price)}, over the ${gweiOf(cap)} cap (OPS_MAX_GAS_PRICE_${chain.toUpperCase()})`;
}

async function prepare(ctx: Ctx, chain: ChainName, label: string, gas: bigint, gasLimit?: bigint) {
  const price = await gasPriceOf(ctx.rpc, chain);
  const over = overCap(ctx, chain, price);
  if (over) throw new SendRefused("fee", `${over}; ${label} waits for it to fall; nothing sent`);
  ctx.log(`${chainLabel(chain)}: ${label} — est. ${gas.toLocaleString("en-US")} gas ≈ ${formatEther(gas * price)} ${unit(chain)}`);
  const limit = gasLimit ?? (gas * 125n + 99n) / 100n;
  const t = ctx.targets[chain];
  const s = signerOf(ctx);
  return [
    "--rpc-url",
    t.rpcUrl,
    "--keystore",
    s.keystore,
    "--password-file",
    s.passwordFile,
    "--gas-limit",
    limit.toString(),
    ...(t.legacy ? ["--legacy", "--gas-price", price.toString()] : []),
  ];
}

export type Receipt = {
  status: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  contractAddress: Address | null;
  logs?: { address: Address; topics: Hex[]; data: Hex }[];
};

/** Polls for the receipt; an RPC error is retried until the deadline, since the transaction is out. */
export async function waitReceipt(ctx: Ctx, chain: ChainName, nonce: number, hash: Hex, request?: CallRequest): Promise<Receipt> {
  const deadline = Date.now() + ctx.receiptTimeoutMs;
  for (;;) {
    try {
      const r = (await ctx.rpc.request(chain, "eth_getTransactionReceipt", [hash])) as Receipt | null;
      if (r) return r;
    } catch {
      // keep waiting: the transaction was broadcast
    }
    if (Date.now() >= deadline) throw new ReceiptTimeout(chain, nonce, hash, request);
    await sleep(ctx.pollMs ?? 3_000);
  }
}

/** Why a mined transaction reverted, as far as a replay can tell: its call as an eth_call at the block it
 * was mined in (that block's end state, which holds the price moves that beat it), then at the block
 * before. The first replay that reverts gives the reason (describeRevert: a Cascade contract's error by
 * name, Error(string) with its text); neither reverting, or the node not answering, gives undefined. Reads
 * only: nothing is sent. */
export async function revertReason(
  ctx: Pick<Ctx, "rpc">,
  chain: ChainName,
  tx: { from: Address; to?: Address; data: Hex; value: Hex },
  block: Hex,
  errors?: Abi,
): Promise<string | undefined> {
  const mined = hexToBigInt(block);
  for (const at of [mined, mined - 1n]) {
    if (at < 0n) break;
    try {
      await ctx.rpc.request(chain, "eth_call", [tx, numberToHex(at)]);
    } catch (e) {
      return isRevert(e) ? describeRevert(e, errors) : undefined;
    }
  }
  return undefined;
}

/** Foundry gave no hash. If the wallet's nonce moved past this one (pending or mined), the node took
 * the transaction: report it as waiting, never as a failure to retry. Otherwise the send failed. */
async function noHash(ctx: Ctx, chain: ChainName, nonce: number, label: string, out: { stdout: string; stderr: string }) {
  const pending = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [signerOf(ctx).address, "pending"])) as Hex);
  const mined = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [signerOf(ctx).address, "latest"])) as Hex);
  if (pending > nonce || mined > nonce) return new ReceiptTimeout(chain, nonce);
  return new Error(`${chainLabel(chain)}: ${label} failed: ${redact(ctx.targets, out.stderr.trim() || out.stdout.trim())}`);
}

export function settle(chain: ChainName, label: string, hash: Hex, r: Receipt, reason?: string): Sent {
  if (r.status !== "0x1") throw new RevertedOnChain(chain, label, hash, reason);
  const gasUsed = hexToBigInt(r.gasUsed);
  return { hash, block: hexToNumber(r.blockNumber), gasUsed, costWei: gasUsed * hexToBigInt(r.effectiveGasPrice), logs: r.logs ?? [] };
}

const hashIn = (out: string) => out.match(/0x[0-9a-fA-F]{64}/)?.[0] as Hex | undefined;

/** What a v3.2 create tells its caller as it goes: `signed` once the transaction is signed and before it is broadcast
 * (its hash, which the deployment record keeps for good, so a run stopped anywhere after this, or a broadcast whose
 * answer was lost while the node took it, is settled by its hash). */
export interface CreateHooks {
  signed?(hash: Hex): void;
}

/** Which build a create is tied to: v3.2's for a version-32 request (routed first, before any v3-launch path), else
 * v3-launch's. Refused, before anything is read or sent, when it cannot be tied to one: a version other than 32, a
 * version-32 request without its build, or a request that names no version but carries libraries or a build
 * (v3-launch's creates link nothing). */
export function createRoute(req: CreateRequest | CreateRequestV32): "v3.2" | "v3-launch" {
  const r = req as Partial<CreateRequestV32>;
  if (r.version === 32) {
    if (!r.build) throw new SendRefused("build", `${chainLabel(req.chain)}: ${req.label} is a v3.2 create without v3.2's frozen build; nothing sent`);
    return "v3.2";
  }
  if (r.version !== undefined || r.libraries !== undefined || r.build !== undefined) {
    const what = r.version !== undefined ? `version ${String(r.version)}` : "libraries or a build, but not version 32";
    throw new SendRefused(
      "build",
      `${chainLabel(req.chain)}: ${req.label} cannot be tied to one build (${what}): v3-launch's creates link nothing, and v3.2's carry version 32 and their build; nothing sent`,
    );
  }
  return "v3-launch";
}

/** Sends a create. A v3.2 one (createRoute) takes v3.2's path, sendCreateV32. Every other is a v3-launch plan's, sent
 * with `forge create`, which builds this checkout's contracts/ (no creation code on the command line): deploy sends a
 * v3-launch plan's creates only from a checkout of its build (builds.ts, assertCheckoutIs), so its constructor's
 * inputs and the creation code its gas is estimated with come from v3-launch's frozen build (builds.ts,
 * preauditArtifact), never contracts/out, which holds v3.2. */
export async function sendCreate(ctx: Ctx, req: CreateRequest | CreateRequestV32, predicted: Address, hooks: CreateHooks = {}): Promise<Sent> {
  if (createRoute(req) === "v3.2") return sendCreateV32(ctx, req as CreateRequestV32, predicted, hooks);
  await guard(ctx, req.chain, req.nonce);
  const name = req.contract.split(":")[1];
  const artifact = preauditArtifact(name);
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: req.args } as never);
  const gas = await estimate(ctx, req.chain, { from: signerOf(ctx).address, data }, req.label);
  const common = await prepare(ctx, req.chain, req.label, gas);
  const inputs = (artifact.abi.find((i) => i.type === "constructor") as { inputs: readonly AbiParameter[] } | undefined)?.inputs ?? [];
  const args = [
    "create",
    req.contract,
    ...common,
    "--nonce",
    String(req.nonce),
    "--timeout",
    String(Math.ceil(ctx.receiptTimeoutMs / 1000)),
    "--broadcast",
    "--json",
    ...(inputs.length ? ["--constructor-args", ...inputs.map((p, i) => castArg(req.args[i], p))] : []),
  ];
  await checkSigner(ctx);
  const out = await ctx.runner.run(bin(ctx, "forge"), args, { cwd: ctx.paths.contractsDir });
  const hash = out.code === 0 ? hashIn(out.stdout) : undefined;
  // forge waits for the receipt itself; without a hash, the nonces tell a sent transaction from a failed send
  if (!hash) throw await noHash(ctx, req.chain, req.nonce, req.label, out);
  const r = await waitReceipt(ctx, req.chain, req.nonce, hash);
  const sent = settle(req.chain, req.label, hash, r);
  const got = r.contractAddress;
  if (!got || got.toLowerCase() !== predicted.toLowerCase()) {
    throw new Error(`${chainLabel(req.chain)}: expected the contract at ${predicted}, but it landed at ${got}`);
  }
  // a load-balanced RPC can answer from a node a block behind the receipt: give it a moment
  for (let i = 0; (await codeAt(ctx.rpc, req.chain, predicted)) === "0x"; i++) {
    if (i >= 10) throw new Error(`${chainLabel(req.chain)}: no code at ${predicted} after the receipt (transaction ${hash})`);
    await sleep(ctx.pollMs ?? 3_000);
  }
  return { ...sent, address: predicted };
}

/** secp256k1's order over 2: a signature whose s is above it is the malleable twin, which nodes refuse. */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Why the signed transaction `raw` is not `tx` signed by `from`, or null. Decoded back, every field must be the planned
 * one (the type, the chain id, the nonce, no `to` for a create and the planned one for a call (v3.2's relayed stamp,
 * v32/stamp.ts), the planned value (0 unless given), the data byte for byte, the gas, the fee fields, no access list),
 * its signature's s must be low, and it must recover to `from`. */
export async function signedTransactionProblem(tx: TransactionSerializable, raw: Hex, from: Address): Promise<string | null> {
  let got: ReturnType<typeof parseTransaction>;
  try {
    got = parseTransaction(raw);
  } catch (e) {
    return `it does not decode (${(e as Error).message.split("\n")[0]})`;
  }
  const fees = tx.type === "legacy" ? ["gasPrice"] : ["maxFeePerGas", "maxPriorityFeePerGas"];
  const field = (o: unknown, k: string) => (o as Record<string, unknown>)[k];
  const pairs: [string, unknown, unknown][] = [
    ["type", got.type, tx.type],
    ["chainId", got.chainId, tx.chainId],
    ["nonce", got.nonce, tx.nonce],
    ["to", got.to ? got.to.toLowerCase() : null, tx.to ? tx.to.toLowerCase() : null],
    ["value", got.value ?? 0n, tx.value ?? 0n],
    ["data", (got.data ?? "0x").toLowerCase(), (tx.data ?? "0x").toLowerCase()],
    ["gas", got.gas, tx.gas],
    ...fees.map((f): [string, unknown, unknown] => [f, field(got, f), field(tx, f)]),
    ["access list's length", ((field(got, "accessList") as unknown[] | undefined) ?? []).length, 0],
  ];
  for (const [name, g, w] of pairs) {
    if (g !== w) return name === "data" ? `its data is not the planned ${tx.to ? "calldata" : "creation code and arguments"}` : `its ${name} is ${String(g)}, not the planned ${String(w)}`;
  }
  // the malleable twin recovers to the same signer, but nodes refuse a high s (EIP-2; Task 44's re-review, N1)
  if (!got.s || !got.r) return "it carries no signature";
  if (hexToBigInt(got.s) > HALF_N) return "its signature's s is high (the malleable twin), which nodes refuse";
  const by = await recoverTransactionAddress({ serializedTransaction: raw as never });
  return by.toLowerCase() === from.toLowerCase() ? null : `it recovers to ${by}, not ${from}`;
}

/** `tx` signed by the context's signer. Foundry's `cast wallet sign --no-hash` signs the transaction's hash with the
 * keystore (by path: the key never leaves Foundry); the signature must recover to the signer's address, with a low s;
 * the signed transaction is put together (`assemble`, viem's serializeTransaction) and decoded back, and must be `tx`
 * from the signer (signedTransactionProblem; Task 44's review, I-1). Refused ("signer"), nothing sent, otherwise. */
export async function signTransaction(
  ctx: Ctx,
  tx: TransactionSerializable,
  assemble: (tx: TransactionSerializable, sig: Signature) => Hex = (t, sig) => serializeTransaction(t, sig),
): Promise<Hex> {
  const s = signerOf(ctx);
  const digest = keccak256(serializeTransaction(tx));
  const out = await ctx.runner.run(bin(ctx, "cast"), ["wallet", "sign", "--no-hash", digest, "--keystore", s.keystore, "--password-file", s.passwordFile], {
    cwd: ctx.paths.contractsDir,
  });
  const sig = out.code === 0 ? (out.stdout.match(/0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/)?.[0] as Hex | undefined) : undefined;
  if (!sig) {
    const why = redact(ctx.targets, out.stderr.trim() || out.stdout.trim()) || `exit ${out.code}`;
    throw new SendRefused("signer", `${s.name}'s keystore did not sign (${why}); nothing sent`);
  }
  const { r, s: sv, yParity } = parseSignature(sig);
  if (hexToBigInt(sv) > HALF_N) throw new SendRefused("signer", `${s.name}'s keystore gave a high-s signature, which nodes refuse; nothing sent`);
  const by = await recoverAddress({ hash: digest, signature: sig });
  if (by.toLowerCase() !== s.address.toLowerCase()) throw new SendRefused("signer", `the keystore signed as ${by}, not ${s.name} ${s.address}; nothing sent`);
  const raw = assemble(tx, { r, s: sv, yParity, v: 27n + BigInt(yParity) });
  const problem = await signedTransactionProblem(tx, raw, s.address);
  if (problem) throw new SendRefused("signer", `the signed transaction, decoded back, is not the planned one: ${problem}; nothing sent`);
  return raw;
}

/** A v3.2 create: exactly the linked creation code of its frozen build (build.ts deployDataV32, the one link path,
 * ruling DB4), estimated with those bytes, signed by the deployer's keystore and broadcast as those bytes, so what is
 * sent is what the build (and Task 45's verify) says; never `forge create`, which would build the checkout's sources.
 * The same gate, chain id and nonce checks as every send come first (the deployer's mined and pending nonces must both
 * be the planned one); the gas may not exceed the request's ceiling, nor the fees the cap. The signed transaction is
 * decoded back before it goes (signTransaction), and its hash goes to `hooks.signed` before the broadcast. A mined
 * revert throws RevertedOnChain; a receipt that names no contract or another address than `predicted`,
 * UnexpectedReceipt; a good receipt with no code seen there yet, CodeNotYetSeen; no receipt in time, ReceiptTimeout. */
async function sendCreateV32(ctx: Ctx, req: CreateRequestV32, predicted: Address, hooks: CreateHooks): Promise<Sent> {
  const chain = req.chain;
  await guard(ctx, chain, req.nonce);
  const errors = buildErrorsV32(req.build);
  const data = deployDataV32(req.build, req);
  const from = signerOf(ctx).address;
  const gas = await estimate(ctx, chain, { from, data }, req.label, errors);
  if (gas > req.gasCeiling) {
    throw new SendRefused(
      "estimate",
      `${chainLabel(chain)}: ${req.label} needs ${gas.toLocaleString("en-US")} gas, more than the ${req.gasCeiling.toLocaleString("en-US")} the plan's funding counts for it; nothing sent`,
    );
  }
  const padded = (gas * 125n + 99n) / 100n;
  const limit = padded < req.gasCeiling ? padded : req.gasCeiling;
  const price = await gasPriceOf(ctx.rpc, chain);
  const over = overCap(ctx, chain, price);
  if (over) throw new SendRefused("fee", `${over}; ${req.label} waits for it to fall; nothing sent`);
  ctx.log(`${chainLabel(chain)}: ${req.label} — est. ${gas.toLocaleString("en-US")} gas ≈ ${formatEther(gas * price)} ${unit(chain)}`);
  const t = ctx.targets[chain];
  const tip = t.legacy ? 0n : await priorityFeeOf(ctx.rpc, chain);
  // the node's gas price is its base fee and its suggested tip together, so a tip above it is no honest answer, and it
  // would lift the fee cap past OPS_MAX_GAS_PRICE_* (Task 44's review, M1)
  if (tip > price) {
    throw new SendRefused("fee", `${chainLabel(chain)}: the node suggests a priority fee of ${gweiOf(tip)}, above its gas price of ${gweiOf(price)}; ${req.label} not sent`);
  }
  const maxFee = 2n * price;
  const cap = ctx.maxGasPrice?.[chain];
  if (!t.legacy && cap !== undefined && maxFee > 2n * cap) {
    throw new SendRefused("fee", `${chainLabel(chain)}: a fee cap of ${gweiOf(maxFee)} is over twice the ${gweiOf(cap)} cap; ${req.label} not sent`);
  }
  const tx: TransactionSerializable = t.legacy
    ? { type: "legacy", chainId: t.chainId, nonce: req.nonce, gas: limit, gasPrice: price, data, value: 0n }
    : { type: "eip1559", chainId: t.chainId, nonce: req.nonce, gas: limit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, data, value: 0n };
  await checkSigner(ctx);
  const raw = await signTransaction(ctx, tx);
  const hash = keccak256(raw);
  hooks.signed?.(hash);
  try {
    await ctx.rpc.request(chain, "eth_sendRawTransaction", [raw]);
  } catch (e) {
    // the node may have taken it all the same (its answer lost on the way back): its pool, or the nonce, says so
    // (its hash stays in the record either way: one the node took while its pool and nonce lag is settled next run)
    const known = await ctx.rpc.request(chain, "eth_getTransactionByHash", [hash]).catch(() => null);
    if (!known && (await nonceOf(ctx.rpc, chain, from)) <= req.nonce) {
      throw new Error(`${chainLabel(chain)}: ${req.label} was not sent, as far as the node says (${redact(ctx.targets, (e as Error).message)}); its hash is kept, and the next run settles it first`);
    }
  }
  const r = await waitReceipt(ctx, chain, req.nonce, hash);
  const reason = r.status === "0x1" ? undefined : await revertReason(ctx, chain, { from, data, value: "0x0" }, r.blockNumber, errors);
  const sent = settle(chain, req.label, hash, r, reason);
  const got = r.contractAddress;
  if (!got || got.toLowerCase() !== predicted.toLowerCase()) {
    throw new UnexpectedReceipt(`${chainLabel(chain)}: ${req.label} (transaction ${hash}) was planned at ${predicted}, but its receipt names ${got ?? "no contract"}`);
  }
  // a load-balanced RPC can answer from a node a block behind the receipt: give it a moment, then leave the code to the
  // next run's check (the controller's ruling on the review's M3: RPC lag after a good receipt voids nothing)
  for (let i = 0; (await codeAt(ctx.rpc, chain, predicted)) === "0x"; i++) {
    if (i >= 10) {
      throw new CodeNotYetSeen(`${chainLabel(chain)}: ${req.label}'s receipt (transaction ${hash}) is good, at ${predicted}, but the RPC shows no code there yet`, {
        ...sent,
        address: predicted,
      });
    }
    await sleep(ctx.pollMs ?? 3_000);
  }
  return { ...sent, address: predicted };
}

/** Calls with `cast send --async`, then waits for the receipt here. One that reverts on chain is thrown
 * with its reason, when a replay at its block can tell it (revertReason). */
export async function sendCall(ctx: Ctx, req: CallRequest): Promise<Sent> {
  await guard(ctx, req.chain, req.nonce);
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
  const tx = { from: signerOf(ctx).address, to: req.to, data, value: numberToHex(req.value ?? 0n) };
  const gas = await estimate(ctx, req.chain, tx, req.label);
  if (req.gasLimit !== undefined && gas > req.gasLimit) {
    throw new SendRefused(
      "estimate",
      `${chainLabel(req.chain)}: ${req.label} needs ${gas.toLocaleString("en-US")} gas, more than the ${req.gasLimit.toLocaleString("en-US")} it is sent with; nothing sent`,
    );
  }
  const common = await prepare(ctx, req.chain, req.label, gas, req.gasLimit);
  const fn = req.abi.find((i) => i.type === "function" && i.name === req.functionName) as AbiFunction;
  const args = [
    "send",
    req.to,
    toFunctionSignature(fn),
    ...fn.inputs.map((p, i) => castArg(req.args[i], p)),
    ...(req.value ? ["--value", req.value.toString()] : []),
    ...common,
    "--nonce",
    String(req.nonce),
    "--async",
  ];
  await checkSigner(ctx);
  const out = await ctx.runner.run(bin(ctx, "cast"), args, { cwd: ctx.paths.contractsDir });
  const hash = out.code === 0 ? hashIn(out.stdout) : undefined;
  if (!hash) throw await noHash(ctx, req.chain, req.nonce, req.label, out);
  const r = await waitReceipt(ctx, req.chain, req.nonce, hash, req);
  return settle(req.chain, req.label, hash, r, r.status === "0x1" ? undefined : await revertReason(ctx, req.chain, tx, r.blockNumber));
}

/** A replacement's fee over the pending transaction's: 12.5% (nodes take a replacement from 10% more). */
const bumped = (fee: bigint) => (fee * 1125n + 999n) / 1000n;
/** Gas for a plain transfer of nothing to oneself: the cancel. */
const CANCEL_GAS = 21_000n;

/** A transaction as the node's pool or chain describes it (eth_getTransactionByHash). */
type PoolTx = { from: Address; nonce: Hex; blockNumber: Hex | null; gasPrice?: Hex; maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex };

/** Replaces the signer's own pending transaction at req.nonce, one of `pending` (the hash sendCall got
 * for `req`, then each replacement's, oldest first; none has had a receipt since), at the same nonce
 * with a higher fee: the same call, when it still passes its estimate, else, only when that estimate is
 * a genuine revert (the call would fail now), a cancel (a transfer of nothing to the signer, which only
 * frees the nonce), so a transaction stuck pending (its fee under the market's since) no longer holds the
 * chain's sends for good. Safe by construction: two transactions at one nonce can't both be mined, so
 * this never doubles a send. The hashes are looked up newest first, and the first still in the pool is
 * the one replaced (a later replacement the pool evicted never hides an original still in it). Nothing
 * is sent unless that one is from the signer, at req.nonce, and nothing has been mined at that nonce
 * (`replaced: false` otherwise: one of them landed, or all dropped, and the wallet's nonce says which),
 * and nothing is sent either when the node didn't answer the estimate (an RPC error, a rate limit, a
 * timeout: not a revert, so no cancel) or the price would be over the chain's cap (overCap, as prepare
 * judges a fresh send): `replaced: false`, tried again later. The live gate, the chain id and the
 * keystore's account are checked as for any send (the record's readiness and the wallet's code are the
 * keeper's checks, before it calls this). Fees: 12.5% over the pending transaction's (both the fee cap
 * and the tip under EIP-1559, the tip never under the node's suggested one; the gas price on a legacy
 * chain), and never under the node's gas price now. Then the receipt is waited for as in sendCall: a
 * timeout throws ReceiptTimeout with the replacement's hash and `req`, so it can be replaced in turn; a
 * revert throws RevertedOnChain with its reason; cast refusing it ("replacement transaction
 * underpriced", "nonce too low") throws a plain Error. */
export async function replaceCall(ctx: Ctx, req: CallRequest, pending: readonly Hex[]): Promise<Replacement> {
  const chain = req.chain;
  await gate(ctx, chain);
  const from = signerOf(ctx);
  let pooled: { hash: Hex; tx: PoolTx } | undefined;
  for (const hash of [...pending].reverse()) {
    const tx = (await ctx.rpc.request(chain, "eth_getTransactionByHash", [hash])) as PoolTx | null;
    if (!tx) continue;
    if (tx.blockNumber !== null) return { replaced: false, reason: `transaction ${hash} was mined meanwhile (block ${hexToNumber(tx.blockNumber)})` };
    if (tx.from.toLowerCase() !== from.address.toLowerCase() || hexToNumber(tx.nonce) !== req.nonce) {
      return { replaced: false, reason: `transaction ${hash} is not ${from.name}'s at nonce ${req.nonce}: nothing to replace` };
    }
    pooled = { hash, tx };
    break;
  }
  if (!pooled) {
    return { replaced: false, reason: `none of transaction${pending.length === 1 ? "" : "s"} ${pending.join(", ")} is in the node's pool any more (dropped, or on another node): the wallet's nonce decides` };
  }
  const { hash: replacing, tx } = pooled;
  const mined = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [from.address, "latest"])) as Hex);
  if (mined !== req.nonce) return { replaced: false, reason: `${chainLabel(chain)}: the wallet's mined nonce is ${mined}, so nonce ${req.nonce} is no longer pending` };
  const market = await gasPriceOf(ctx.rpc, chain);
  const t = ctx.targets[chain];
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  // cast's --gas-price is the gas price of a legacy transaction, the fee cap of an EIP-1559 one
  const nodeTip = t.legacy ? 0n : await priorityFeeOf(ctx.rpc, chain);
  const tip = t.legacy ? 0n : max(bumped(hexToBigInt(tx.maxPriorityFeePerGas ?? "0x0")), nodeTip);
  const cap = max(max(bumped(hexToBigInt((t.legacy ? tx.gasPrice : (tx.maxFeePerGas ?? tx.gasPrice)) ?? "0x0")), market), tip);
  // what it would pay a gas now, judged as prepare judges a fresh send: the node's gas price is the base
  // fee plus its suggested tip, so the base fee is the difference, and a 1559 transaction pays the lower
  // of its fee cap and the base fee plus its own tip
  const baseFee = market > nodeTip ? market - nodeTip : market;
  const effective = t.legacy ? cap : cap < baseFee + tip ? cap : baseFee + tip;
  const over = overCap(ctx, chain, effective);
  if (over) return { replaced: false, reason: `${over}; the replacement waits for it to fall` };
  const fee = t.legacy ? ["--legacy", "--gas-price", cap.toString()] : ["--gas-price", cap.toString(), "--priority-gas-price", tip.toString()];
  const feeInWords = t.legacy ? `gas price ${gweiOf(cap)}` : `fee cap ${gweiOf(cap)}, tip ${gweiOf(tip)}`;
  // the same call, if it still passes; a cancel (21,000 gas, which only frees the nonce) when the call
  // would revert now; nothing when the node didn't answer
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
  const callTx = { from: from.address, to: req.to, data, value: numberToHex(req.value ?? 0n) };
  let cancelled = false;
  let call: string[];
  let limit: bigint;
  try {
    const gas = hexToBigInt((await ctx.rpc.request(chain, "eth_estimateGas", [callTx])) as Hex);
    const fn = req.abi.find((i) => i.type === "function" && i.name === req.functionName) as AbiFunction;
    call = [req.to, toFunctionSignature(fn), ...fn.inputs.map((p, i) => castArg(req.args[i], p)), ...(req.value ? ["--value", req.value.toString()] : [])];
    limit = req.gasLimit ?? (gas * 125n + 99n) / 100n;
  } catch (e) {
    if (!isRevert(e)) {
      return { replaced: false, reason: `${chainLabel(chain)}: the node didn't answer the estimate of ${req.label} (${redact(ctx.targets, (e as Error).message)}); nothing cancelled` };
    }
    ctx.log(`${chainLabel(chain)}: ${req.label} would fail now (${describeRevert(e)}): nonce ${req.nonce} is cancelled instead`);
    cancelled = true;
    call = [from.address, "--value", "0"];
    limit = CANCEL_GAS;
  }
  const label = cancelled ? `cancel nonce ${req.nonce} (${req.label})` : `${req.label} (replacing ${replacing})`;
  ctx.log(`${chainLabel(chain)}: ${label} — nonce ${req.nonce}, ${feeInWords} (12.5% over the pending transaction's, never under the node's)`);
  const args = ["send", ...call, "--rpc-url", t.rpcUrl, "--keystore", from.keystore, "--password-file", from.passwordFile, "--gas-limit", limit.toString(), ...fee, "--nonce", String(req.nonce), "--async"];
  await checkSigner(ctx);
  const out = await ctx.runner.run(bin(ctx, "cast"), args, { cwd: ctx.paths.contractsDir });
  const hash = out.code === 0 ? hashIn(out.stdout) : undefined;
  // not noHash: nonce `req.nonce` is pending by definition here, so its nonces say nothing about this send
  if (!hash) throw new Error(`${chainLabel(chain)}: ${label} was not sent: ${redact(ctx.targets, out.stderr.trim() || out.stdout.trim())}`);
  const r = await waitReceipt(ctx, chain, req.nonce, hash, req);
  const reason = r.status === "0x1" || cancelled ? undefined : await revertReason(ctx, chain, callTx, r.blockNumber);
  return { replaced: true, cancelled, ...settle(chain, label, hash, r, reason) };
}

/** A plain value transfer with `cast send <to> --value`, through the same checks. */
export async function sendValue(
  ctx: Ctx,
  req: { chain: ChainName; nonce: number; label: string; to: Address; value: bigint },
): Promise<Sent> {
  await guard(ctx, req.chain, req.nonce);
  const gas = await estimate(ctx, req.chain, { from: signerOf(ctx).address, to: req.to, data: "0x", value: numberToHex(req.value) }, req.label);
  const common = await prepare(ctx, req.chain, req.label, gas);
  const args = ["send", req.to, "--value", req.value.toString(), ...common, "--nonce", String(req.nonce), "--async"];
  await checkSigner(ctx);
  const out = await ctx.runner.run(bin(ctx, "cast"), args, { cwd: ctx.paths.contractsDir });
  const hash = out.code === 0 ? hashIn(out.stdout) : undefined;
  if (!hash) throw await noHash(ctx, req.chain, req.nonce, req.label, out);
  return settle(req.chain, req.label, hash, await waitReceipt(ctx, req.chain, req.nonce, hash));
}
