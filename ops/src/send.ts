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
import { chainIdOf, codeAt, gasPriceOf, nonceOf, type Rpc, RpcError } from "./rpc.ts";
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

/** The transaction was mined and reverted: its receipt's status is not 1. */
export class RevertedOnChain extends Error {
  readonly chain: ChainName;
  readonly hash: Hex;

  constructor(chain: ChainName, label: string, hash: Hex) {
    super(`${chainLabel(chain)}: ${label} reverted on chain (transaction ${hash})`);
    this.chain = chain;
    this.hash = hash;
  }
}

/** The transaction was sent but no receipt came within the wait. `hash` is unknown when forge timed out. */
export class ReceiptTimeout extends Error {
  readonly hash?: Hex;
  readonly chain: ChainName;
  readonly nonce: number;

  constructor(chain: ChainName, nonce: number, hash?: Hex) {
    super(`${chainLabel(chain)}: no receipt yet for nonce ${nonce}${hash ? ` (transaction ${hash})` : ""}; nothing more will be sent until it is mined or dropped`);
    this.hash = hash;
    this.chain = chain;
    this.nonce = nonce;
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

/** Which server the live tools read Base's logs from: its origin only (a provider's key, in its path or
 * query, never printed). */
export const baseLogsLine = (target: ChainTarget) =>
  `Reading Base's logs from ${redact({ base: target, bittensor: target }, target.rpcUrl)} (set OPS_BASE_LOGS_RPC to change it)`;

const isLocal = (url: string) => ["127.0.0.1", "localhost"].includes(new URL(url).hostname);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bin = (ctx: Ctx, name: string) => join(ctx.paths.foundryBin, process.platform === "win32" ? `${name}.exe` : name);

/** Live gate, chain id and nonce: all before anything is estimated. */
async function guard(ctx: Ctx, chain: ChainName, nonce: number): Promise<void> {
  const local = Object.values(ctx.targets).every((t) => isLocal(t.rpcUrl));
  const remote = Object.values(ctx.targets).every((t) => !isLocal(t.rpcUrl));
  if (!ctx.live && !local) throw new SendRefused("not-live", "this command would reach the live networks: add --live to mean it");
  if (ctx.live && !remote) throw new SendRefused("not-live", "--live was given but an RPC points at this machine");
  const id = await chainIdOf(ctx.rpc, chain);
  if (id !== ctx.targets[chain].chainId) {
    throw new SendRefused("chain-id", `${chainLabel(chain)}: the RPC reports chain id ${id}, expected ${ctx.targets[chain].chainId}`);
  }
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
async function waitReceipt(ctx: Ctx, chain: ChainName, nonce: number, hash: Hex): Promise<Receipt> {
  const deadline = Date.now() + ctx.receiptTimeoutMs;
  for (;;) {
    try {
      const r = (await ctx.rpc.request(chain, "eth_getTransactionReceipt", [hash])) as Receipt | null;
      if (r) return r;
    } catch {
      // keep waiting: the transaction was broadcast
    }
    if (Date.now() >= deadline) throw new ReceiptTimeout(chain, nonce, hash);
    await sleep(ctx.pollMs ?? 3_000);
  }
}

/** Foundry gave no hash. If the wallet's nonce moved past this one (pending or mined), the node took
 * the transaction: report it as waiting, never as a failure to retry. Otherwise the send failed. */
async function noHash(ctx: Ctx, chain: ChainName, nonce: number, label: string, out: { stdout: string; stderr: string }) {
  const pending = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [signerOf(ctx).address, "pending"])) as Hex);
  const mined = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [signerOf(ctx).address, "latest"])) as Hex);
  if (pending > nonce || mined > nonce) return new ReceiptTimeout(chain, nonce);
  return new Error(`${chainLabel(chain)}: ${label} failed: ${redact(ctx.targets, out.stderr.trim() || out.stdout.trim())}`);
}

function settle(chain: ChainName, label: string, hash: Hex, r: Receipt): Sent {
  if (r.status !== "0x1") throw new RevertedOnChain(chain, label, hash);
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

/** Calls with `cast send --async`, then waits for the receipt here. */
export async function sendCall(ctx: Ctx, req: CallRequest): Promise<Sent> {
  await guard(ctx, req.chain, req.nonce);
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
  const gas = await estimate(ctx, req.chain, { from: signerOf(ctx).address, to: req.to, data, value: numberToHex(req.value ?? 0n) }, req.label);
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
  return settle(req.chain, req.label, hash, await waitReceipt(ctx, req.chain, req.nonce, hash));
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
