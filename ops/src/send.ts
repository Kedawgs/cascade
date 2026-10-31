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
  numberToHex,
  toFunctionSignature,
} from "viem";
import { loadArtifact } from "./artifacts.ts";
import { type ChainName, type ChainTarget, type Paths, WALLET } from "./config.ts";
import { chainIdOf, codeAt, gasPriceOf, isRevert, nonceOf, type Rpc, RpcError } from "./rpc.ts";
import type { CallRequest, CreateRequest } from "./types.ts";

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
  /** Who sends: absent = the test wallet with paths.keystore (every command but pause and unpause). */
  signer?: Signer;
  runner: Runner;
  paths: Paths;
  log(line: string): void;
  receiptTimeoutMs: number;
  pollMs?: number;
}

export interface Sent {
  hash: Hex;
  block: number;
  gasUsed: bigint;
  costWei: bigint;
  address?: Address;
  logs?: { address: Address; topics: Hex[]; data: Hex }[];
}

export type RefusalReason = "not-live" | "chain-id" | "nonce" | "waiting" | "estimate" | "signer";

export class SendRefused extends Error {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The transaction was mined and reverted: its receipt's status is not 1. `reason` is why, when the
 * call, replayed at the block it reverted in (revertReason), reverts too: a Cascade contract's error by
 * name (BelowMinimum()), Error(string) with its text ("Too little received"); unset when the replay goes
 * through (the state moved within the block) or the node didn't answer it. */
export class RevertedOnChain extends Error {
  readonly chain: ChainName;
  readonly hash: Hex;
  readonly reason?: string;

  constructor(chain: ChainName, label: string, hash: Hex, reason?: string) {
    super(`${chainLabel(chain)}: ${label} reverted on chain (transaction ${hash}${reason ? `, ${reason}` : ""})`);
    this.chain = chain;
    this.hash = hash;
    this.reason = reason;
  }
}

/** The transaction was sent but no receipt came within the wait. `hash` is unknown when forge timed out.
 * `request` is the call it carries (sendCall's), for a replacement at the same nonce (replaceCall). */
export class ReceiptTimeout extends Error {
  readonly hash?: Hex;
  readonly chain: ChainName;
  readonly nonce: number;
  readonly request?: CallRequest;

  constructor(chain: ChainName, nonce: number, hash?: Hex, request?: CallRequest) {
    super(`${chainLabel(chain)}: no receipt yet for nonce ${nonce}${hash ? ` (transaction ${hash})` : ""}; nothing more will be sent until it is mined or dropped`);
    this.hash = hash;
    this.chain = chain;
    this.nonce = nonce;
    this.request = request;
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

/** The RPC for log scans and their heads: the context's logs server, else its main RPC. */
export const logsOf = (ctx: Pick<Ctx, "rpc" | "logs">): Rpc => ctx.logs ?? ctx.rpc;

export const chainLabel = (chain: ChainName) => (chain === "base" ? "Base" : "Bittensor");
export const unit = (chain: ChainName) => (chain === "base" ? "ETH" : "TAO");

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

/** A URL: its scheme, its authority (user info, host, port), and the rest (path, query, fragment). */
const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#"'<>()[\]]+)([^\s"'<>()[\]]*)/gi;

/** `text` with every URL cut down to its scheme, its host's last two labels and its port (no user info,
 * subdomain, path or query, where a provider's key can sit; a bare "/" carries none and stays, so the
 * sign page's http://127.0.0.1:<port>/ still opens), and every key-like `name=value` value dropped.
 * Unlike redact it needs no list of RPCs: every line the CLI prints goes through it (output.ts). */
export function scrubSecrets(text: string): string {
  return text
    .replace(URL_IN_TEXT, (_m, scheme: string, authority: string, rest: string) => {
      const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
      const colon = hostPort.lastIndexOf(":");
      const host = colon > 0 && !hostPort.endsWith("]") ? hostPort.slice(0, colon) : hostPort;
      const port = host === hostPort ? "" : hostPort.slice(colon);
      const labels = host.split(".");
      const shown = /^[\d.]+$/.test(host) || host.startsWith("[") || labels.length <= 2 ? host : `…${labels.slice(-2).join(".")}`;
      return `${scheme}://${shown}${port}${rest === "" || rest === "/" ? rest : "/…"}`;
    })
    .replace(/\b((?:d|api_?)?key|token|secret|password|passwd)=[^&\s)"']+/gi, "$1=…");
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
const bin = (ctx: Ctx, name: string) => join(ctx.paths.foundryBin, process.platform === "win32" ? `${name}.exe` : name);

/** The live gate and the chain id: before anything is estimated or signed. */
async function gate(ctx: Ctx, chain: ChainName): Promise<void> {
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

/** The contracts' custom errors, so a failed estimate can say which one. */
function contractErrors(ctx: Pick<Ctx, "paths">): Abi {
  if (!errorAbi) {
    const names = ["CascadeVault", "CascadeFrontDoor", "CcipBaseAdapter", "CcipBittensorAdapter", "CascadeStaker", "CascadeTwapOracle"];
    errorAbi = names.flatMap((n) => {
      try {
        return loadArtifact(ctx.paths.contractsDir, n).abi.filter((i) => i.type === "error");
      } catch {
        return [];
      }
    });
  }
  return errorAbi;
}

/** A failed call's reason: a Cascade contract's error by name, Error(string) with its text (e.g. the
 * router's "Too little received"), else the node's message. */
export function describeRevert(ctx: Pick<Ctx, "paths">, e: unknown): string {
  const raw = e instanceof RpcError ? e.data : undefined;
  const data = typeof raw === "string" ? raw : (raw as { data?: unknown } | undefined)?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: contractErrors(ctx), data: data as Hex });
      return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
    } catch {
      return `${(e as Error).message}, revert data ${data}`;
    }
  }
  return (e as Error).message;
}

/** eth_estimateGas on the node with no gas price (with one, the node checks the balance and refuses). */
async function estimate(ctx: Ctx, chain: ChainName, tx: { from: Address; to?: Address; data: Hex; value?: Hex }, label: string) {
  try {
    return hexToBigInt((await ctx.rpc.request(chain, "eth_estimateGas", [tx])) as Hex);
  } catch (e) {
    throw new SendRefused("estimate", `${chainLabel(chain)}: ${label} would fail, nothing sent (${describeRevert(ctx, e)})`);
  }
}

async function prepare(ctx: Ctx, chain: ChainName, label: string, gas: bigint, gasLimit?: bigint) {
  const price = await gasPriceOf(ctx.rpc, chain);
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

type Receipt = {
  status: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  contractAddress: Address | null;
  logs?: { address: Address; topics: Hex[]; data: Hex }[];
};

/** Polls for the receipt; an RPC error is retried until the deadline, since the transaction is out. */
async function waitReceipt(ctx: Ctx, chain: ChainName, nonce: number, hash: Hex, request?: CallRequest): Promise<Receipt> {
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
export async function revertReason(ctx: Pick<Ctx, "rpc" | "paths">, chain: ChainName, tx: { from: Address; to: Address; data: Hex; value: Hex }, block: Hex): Promise<string | undefined> {
  const mined = hexToBigInt(block);
  for (const at of [mined, mined - 1n]) {
    if (at < 0n) break;
    try {
      await ctx.rpc.request(chain, "eth_call", [tx, numberToHex(at)]);
    } catch (e) {
      return isRevert(e) ? describeRevert(ctx, e) : undefined;
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

function settle(chain: ChainName, label: string, hash: Hex, r: Receipt, reason?: string): Sent {
  if (r.status !== "0x1") throw new RevertedOnChain(chain, label, hash, reason);
  const gasUsed = hexToBigInt(r.gasUsed);
  return { hash, block: hexToNumber(r.blockNumber), gasUsed, costWei: gasUsed * hexToBigInt(r.effectiveGasPrice), logs: r.logs ?? [] };
}

const hashIn = (out: string) => out.match(/0x[0-9a-fA-F]{64}/)?.[0] as Hex | undefined;

/** Deploys with `forge create`, which reads the build output (no creation code on the command line). */
export async function sendCreate(ctx: Ctx, req: CreateRequest, predicted: Address): Promise<Sent> {
  await guard(ctx, req.chain, req.nonce);
  const name = req.contract.split(":")[1];
  const artifact = loadArtifact(ctx.paths.contractsDir, name);
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

/** What replaceCall did: the pending transaction replaced (the same call again, or a cancel in its place)
 * with the replacement's receipt, or nothing (why). */
export type Replacement = { replaced: false; reason: string } | ({ replaced: true; cancelled: boolean } & Sent);

/** A replacement's fee over the pending transaction's: 12.5% (nodes take a replacement from 10% more). */
const bumped = (fee: bigint) => (fee * 1125n + 999n) / 1000n;
/** Gas for a plain transfer of nothing to oneself: the cancel. */
const CANCEL_GAS = 21_000n;

/** Replaces the signer's own transaction `pending` (the hash sendCall got for `req`, with no receipt
 * since) at the same nonce with a higher fee: the same call, when it still passes its estimate, else a
 * cancel (a transfer of nothing to the signer, which only frees the nonce), so a transaction stuck pending
 * (its fee under the market's since) no longer holds the chain's sends for good. Safe by construction:
 * two transactions at one nonce can't both be mined, so this never doubles a send. Nothing is sent
 * unless `pending` is still in the pool, from the signer, at req.nonce, and nothing has been mined at
 * that nonce (`replaced: false` otherwise: the transaction landed or dropped meanwhile, and the wallet's
 * nonce says which); the live gate, the chain id and the keystore's account are checked as for any send.
 * Fees: 12.5% over the pending transaction's (both the fee cap and the tip under EIP-1559; the gas price
 * on a legacy chain), and never under the node's gas price now. Then the receipt is waited for as in
 * sendCall: a timeout throws ReceiptTimeout with the replacement's hash and `req`, so it can be replaced
 * in turn; a revert throws RevertedOnChain with its reason. */
export async function replaceCall(ctx: Ctx, req: CallRequest, pending: Hex): Promise<Replacement> {
  const chain = req.chain;
  await gate(ctx, chain);
  const from = signerOf(ctx);
  const tx = (await ctx.rpc.request(chain, "eth_getTransactionByHash", [pending])) as
    | { from: Address; nonce: Hex; blockNumber: Hex | null; gasPrice?: Hex; maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex }
    | null;
  if (!tx) return { replaced: false, reason: `transaction ${pending} is not in the node's pool any more (dropped, or on another node): the wallet's nonce decides` };
  if (tx.blockNumber !== null) return { replaced: false, reason: `transaction ${pending} was mined meanwhile (block ${hexToNumber(tx.blockNumber)})` };
  if (tx.from.toLowerCase() !== from.address.toLowerCase() || hexToNumber(tx.nonce) !== req.nonce) {
    return { replaced: false, reason: `transaction ${pending} is not ${from.name}'s at nonce ${req.nonce}: nothing to replace` };
  }
  const mined = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [from.address, "latest"])) as Hex);
  if (mined !== req.nonce) return { replaced: false, reason: `${chainLabel(chain)}: the wallet's mined nonce is ${mined}, so nonce ${req.nonce} is no longer pending` };
  const market = await gasPriceOf(ctx.rpc, chain);
  const t = ctx.targets[chain];
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  // cast's --gas-price is the gas price of a legacy transaction, the fee cap of an EIP-1559 one
  const tip = bumped(hexToBigInt(tx.maxPriorityFeePerGas ?? "0x0"));
  const cap = max(max(bumped(hexToBigInt((t.legacy ? tx.gasPrice : (tx.maxFeePerGas ?? tx.gasPrice)) ?? "0x0")), market), t.legacy ? 0n : tip);
  const fee = t.legacy ? ["--legacy", "--gas-price", cap.toString()] : ["--gas-price", cap.toString(), "--priority-gas-price", tip.toString()];
  const feeInWords = t.legacy ? `gas price ${cap} wei` : `fee cap ${cap} wei, tip ${tip} wei`;
  // the same call, if it still passes; else a cancel, which costs 21,000 gas and frees the nonce
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
  let cancelled = false;
  let call: string[];
  let limit: bigint;
  try {
    const gas = await estimate(ctx, chain, { from: from.address, to: req.to, data, value: numberToHex(req.value ?? 0n) }, req.label);
    const fn = req.abi.find((i) => i.type === "function" && i.name === req.functionName) as AbiFunction;
    call = [req.to, toFunctionSignature(fn), ...fn.inputs.map((p, i) => castArg(req.args[i], p)), ...(req.value ? ["--value", req.value.toString()] : [])];
    limit = req.gasLimit ?? (gas * 125n + 99n) / 100n;
  } catch (e) {
    if (!(e instanceof SendRefused && e.reason === "estimate")) throw e;
    ctx.log(`${e.message}: nonce ${req.nonce} is cancelled instead`);
    cancelled = true;
    call = [from.address, "--value", "0"];
    limit = CANCEL_GAS;
  }
  const label = cancelled ? `cancel nonce ${req.nonce} (${req.label})` : `${req.label} (replacing ${pending})`;
  ctx.log(`${chainLabel(chain)}: ${label} — nonce ${req.nonce}, ${feeInWords} (12.5% over the pending transaction's, never under the node's gas price)`);
  const args = ["send", ...call, "--rpc-url", t.rpcUrl, "--keystore", from.keystore, "--password-file", from.passwordFile, "--gas-limit", limit.toString(), ...fee, "--nonce", String(req.nonce), "--async"];
  await checkSigner(ctx);
  const out = await ctx.runner.run(bin(ctx, "cast"), args, { cwd: ctx.paths.contractsDir });
  const hash = out.code === 0 ? hashIn(out.stdout) : undefined;
  if (!hash) throw await noHash(ctx, chain, req.nonce, label, out);
  const r = await waitReceipt(ctx, chain, req.nonce, hash, req);
  const reason = r.status === "0x1" || cancelled ? undefined : await revertReason(ctx, chain, { from: from.address, to: req.to, data, value: numberToHex(req.value ?? 0n) }, r.blockNumber);
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
