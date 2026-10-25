import {
  type Abi,
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  hexToBigInt,
  hexToNumber,
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

export interface RpcOptions {
  minIntervalMs?: Partial<Record<ChainName, number>>;
  retries?: number;
  backoffMs?: number;
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON-RPC over fetch. Requests on one chain run one at a time; Bittensor's are spaced (the public
 * node allows ~128 a minute) and an HTTP 429 is retried after a backoff. */
export function createRpc(targets: Record<ChainName, ChainTarget>, opts: RpcOptions = {}): Rpc {
  const interval: Record<ChainName, number> = { base: 0, bittensor: 600, ...opts.minIntervalMs };
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

export const chainIdOf = async (rpc: Rpc, chain: ChainName): Promise<number> =>
  hexToNumber((await rpc.request(chain, "eth_chainId", [])) as Hex);

export const gasPriceOf = async (rpc: Rpc, chain: ChainName): Promise<bigint> =>
  hexToBigInt((await rpc.request(chain, "eth_gasPrice", [])) as Hex);
