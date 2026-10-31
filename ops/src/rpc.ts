import {
  type Abi,
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBigInt,
  hexToNumber,
  numberToHex,
} from "viem";
import type { ChainName, ChainTarget } from "./config.ts";

/** The one choke point for JSON-RPC: tests replace it with a fake. */
export interface Rpc {
  request(chain: ChainName, method: string, params: unknown[]): Promise<unknown>;
}

export class RpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** The call really failed in the contract: JSON-RPC code 3, revert data, or a message that says so (a
 * revert, out of gas, an invalid opcode). A node that answered with an error of its own (-32005 limit
 * exceeded, -32000 header not found, -32603) did not run the call, so its answer says nothing about the
 * contract. */
export function isRevert(e: unknown): boolean {
  if (!(e instanceof RpcError)) return false;
  if (e.code === 3) return true;
  const raw = e.data;
  const data = typeof raw === "string" ? raw : (raw as { data?: unknown } | undefined)?.data;
  if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) return true;
  // geth reports a call that ran out of gas or hit an invalid opcode as -32000, with no revert data
  return /revert|out of gas|invalid opcode/i.test(e.message);
}

export interface RpcOptions {
  minIntervalMs?: Partial<Record<ChainName, number>>;
  retries?: number;
  backoffMs?: number;
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON-RPC over fetch. Requests on one chain run one at a time and are spaced (Bittensor's public
 * node allows ~128 a minute; Base's rate-limits bursts), and an HTTP 429 is retried after a backoff. */
export function createRpc(targets: Record<ChainName, ChainTarget>, opts: RpcOptions = {}): Rpc {
  const interval: Record<ChainName, number> = { base: 250, bittensor: 600, ...opts.minIntervalMs };
  const retries = opts.retries ?? 6;
  const backoff = opts.backoffMs ?? 20_000;
  const f = opts.fetch ?? fetch;
  const last: Record<ChainName, number> = { base: 0, bittensor: 0 };
  const queue: Record<ChainName, Promise<unknown>> = { base: Promise.resolve(), bittensor: Promise.resolve() };
  let id = 0;

  async function once(chain: ChainName, method: string, params: unknown[]): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const wait = last[chain] + interval[chain] - Date.now();
      if (wait > 0) await sleep(wait);
      last[chain] = Date.now();
      const res = await f(targets[chain].rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      if (res.status === 429) {
        if (attempt >= retries) throw new RpcError(`${chain} ${method}: still rate limited after ${retries} retries`);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) throw new RpcError(`${chain} ${method}: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message: string; code?: number; data?: unknown } };
      if (body.error) throw new RpcError(`${chain} ${method}: ${body.error.message}`, body.error.code, body.error.data);
      return body.result;
    }
  }

  return {
    request(chain, method, params) {
      const run = () => once(chain, method, params);
      const p = queue[chain].then(run, run);
      queue[chain] = p.catch(() => undefined);
      return p;
    },
  };
}

/** The RPC log scans use: Base's on `baseLogs` (its own server: OPS_BASE_LOGS_RPC), Bittensor's on `main`
 * (the archive node, behind the same rate-limit queue as every other Bittensor read). A scan reads its
 * head here too, so a server that lags can't answer an older head's range as "no logs". Before Base's
 * first request it checks the logs server is Base: one on another chain would answer every query with
 * nothing. */
export function logsRpc(main: Rpc, baseLogs: Rpc, o: { baseChainId?: number; announce?: () => void } = {}): Rpc {
  const baseChainId = o.baseChainId ?? 8453;
  let checked = false;
  let announced = false;
  return {
    async request(chain, method, params) {
      if (chain !== "base") return main.request(chain, method, params);
      // said once, when Base's logs are first read: which server they come from
      if (!announced) {
        announced = true;
        o.announce?.();
      }
      if (!checked) {
        const id = hexToNumber((await baseLogs.request("base", "eth_chainId", [])) as Hex);
        if (id !== baseChainId) {
          throw new Error(`OPS_BASE_LOGS_RPC answers chain id ${id}, not Base (${baseChainId}): set it to a Base RPC that serves eth_getLogs`);
        }
        checked = true;
      }
      return baseLogs.request(chain, method, params);
    },
  };
}

export async function read(
  rpc: Rpc,
  chain: ChainName,
  c: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] },
): Promise<unknown> {
  const data = encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args } as never);
  const out = (await rpc.request(chain, "eth_call", [{ to: c.address, data }, "latest"])) as Hex;
  return decodeFunctionResult({ abi: c.abi, functionName: c.functionName, data: out } as never);
}

export const nonceOf = async (rpc: Rpc, chain: ChainName, addr: Address): Promise<number> =>
  hexToNumber((await rpc.request(chain, "eth_getTransactionCount", [addr, "pending"])) as Hex);

export const balanceOf = async (rpc: Rpc, chain: ChainName, addr: Address): Promise<bigint> =>
  hexToBigInt((await rpc.request(chain, "eth_getBalance", [addr, "latest"])) as Hex);

export const codeAt = async (rpc: Rpc, chain: ChainName, addr: Address): Promise<Hex> =>
  (await rpc.request(chain, "eth_getCode", [addr, "latest"])) as Hex;

/** EIP-7702 lets a plain account's key install code at the account: its code then reads 0xef0100 and the
 * 20-byte address of the contract it delegates to (23 bytes), and calls to the account run that
 * contract's code. A thief with the key can install a sweeper this way (as in the Binance hot-wallet
 * drain). The delegate's address, or undefined for any other code (none, or a contract's own). */
export function delegationOf(code: Hex): Address | undefined {
  return /^0xef0100[0-9a-f]{40}$/i.test(code) ? getAddress(`0x${code.slice(8)}`) : undefined;
}

/** An account's code in words, for a message: the delegation's target, or the code's size. */
export function describeCode(code: Hex): string {
  const to = delegationOf(code);
  return to ? `an EIP-7702 delegation to ${to}` : `${Math.ceil((code.length - 2) / 2)} bytes of contract code`;
}

/** The block `addr`'s code first appears in: steps back from the head, doubling the step, to a block
 * without it, then halves the gap. A recent creation costs few reads, and state is asked for only about
 * twice its age back (Bittensor's archive node keeps it all). */
export async function firstBlockWithCode(rpc: Rpc, chain: ChainName, addr: Address): Promise<number> {
  const has = async (block: bigint) => ((await rpc.request(chain, "eth_getCode", [addr, numberToHex(block)])) as Hex) !== "0x";
  let hi = hexToBigInt((await rpc.request(chain, "eth_blockNumber", [])) as Hex);
  if (!(await has(hi))) throw new Error(`no code at ${addr} at block ${hi}`);
  // hi always has the code; lo never does (-1: before the first block)
  let lo = -1n;
  for (let step = 1n; hi - step >= 0n; step *= 2n) {
    if (!(await has(hi - step))) {
      lo = hi - step;
      break;
    }
    hi -= step;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await has(mid)) hi = mid;
    else lo = mid;
  }
  return Number(hi);
}

export const chainIdOf = async (rpc: Rpc, chain: ChainName): Promise<number> =>
  hexToNumber((await rpc.request(chain, "eth_chainId", [])) as Hex);

export const gasPriceOf = async (rpc: Rpc, chain: ChainName): Promise<bigint> =>
  hexToBigInt((await rpc.request(chain, "eth_gasPrice", [])) as Hex);
