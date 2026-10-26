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
    out = out.replace(new RegExp(`${escape(origin)}[^\s)"'\]]*`, "g"), `${origin}/…`);
  }
  return out.replace(/((?:d|api_?)?key|token|secret)=[^&\s)"']+/gi, "$1=…");
}

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
  const current = await nonceOf(ctx.rpc, chain, WALLET);
  const mined = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [WALLET, "latest"])) as Hex);
  if (mined !== current) {
    throw new SendRefused(
      "waiting",
      `${chainLabel(chain)}: an earlier transaction from the test wallet (nonce ${mined}) is still waiting to be mined; nothing sent — try again once it is`,
    );
  }
  if (current !== nonce) {
    throw new SendRefused("nonce", `${chainLabel(chain)}: the wallet's next nonce is ${current}, the plan expected ${nonce}`);
  }
}

const signerChecked = new WeakSet<Ctx>();

/** Once per run: the keystore must sign as the test wallet, or a send would come from another account. */
async function checkSigner(ctx: Ctx): Promise<void> {
  if (signerChecked.has(ctx)) return;
  const out = await ctx.runner.run(
    bin(ctx, "cast"),
    ["wallet", "address", "--keystore", ctx.paths.keystore, "--password-file", ctx.paths.passwordFile],
    { cwd: ctx.paths.contractsDir },
  );
  const signer = out.stdout.match(/0x[0-9a-fA-F]{40}/)?.[0];
  if (out.code !== 0 || !signer || signer.toLowerCase() !== WALLET.toLowerCase()) {
    throw new SendRefused("signer", `the keystore signs as ${signer ?? "an unknown account"}, not the test wallet ${WALLET}; nothing sent`);
  }
  signerChecked.add(ctx);
}

let errorAbi: Abi | undefined;

/** The contracts' custom errors, so a failed estimate can say which one. */
function contractErrors(ctx: Ctx): Abi {
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

function describeRevert(ctx: Ctx, e: unknown): string {
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

async function prepare(ctx: Ctx, chain: ChainName, label: string, gas: bigint) {
  const price = await gasPriceOf(ctx.rpc, chain);
  ctx.log(`${chainLabel(chain)}: ${label} — est. ${gas.toLocaleString("en-US")} gas ≈ ${formatEther(gas * price)} ${unit(chain)}`);
  const limit = (gas * 125n + 99n) / 100n;
  const t = ctx.targets[chain];
  return [
    "--rpc-url",
    t.rpcUrl,
    "--keystore",
    ctx.paths.keystore,
    "--password-file",
    ctx.paths.passwordFile,
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
  const pending = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [WALLET, "pending"])) as Hex);
  const mined = hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [WALLET, "latest"])) as Hex);
  if (pending > nonce || mined > nonce) return new ReceiptTimeout(chain, nonce);
  return new Error(`${chainLabel(chain)}: ${label} failed: ${redact(ctx.targets, out.stderr.trim() || out.stdout.trim())}`);
}

function settle(chain: ChainName, label: string, hash: Hex, r: Receipt): Sent {
  if (r.status !== "0x1") throw new Error(`${chainLabel(chain)}: ${label} reverted on chain (transaction ${hash})`);
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
  const gas = await estimate(ctx, req.chain, { from: WALLET, data }, req.label);
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
  const gas = await estimate(ctx, req.chain, { from: WALLET, to: req.to, data, value: numberToHex(req.value ?? 0n) }, req.label);
  const common = await prepare(ctx, req.chain, req.label, gas);
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
  const gas = await estimate(ctx, req.chain, { from: WALLET, to: req.to, data: "0x", value: numberToHex(req.value) }, req.label);
  const common = await prepare(ctx, req.chain, req.label, gas);
  const args = ["send", req.to, "--value", req.value.toString(), ...common, "--nonce", String(req.nonce), "--async"];
  await checkSigner(ctx);
  const out = await ctx.runner.run(bin(ctx, "cast"), args, { cwd: ctx.paths.contractsDir });
  const hash = out.code === 0 ? hashIn(out.stdout) : undefined;
  if (!hash) throw await noHash(ctx, req.chain, req.nonce, req.label, out);
  return settle(req.chain, req.label, hash, await waitReceipt(ctx, req.chain, req.nonce, hash));
}
