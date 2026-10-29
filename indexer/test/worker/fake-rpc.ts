import { type Hex, hexToBigInt, numberToHex } from "viem";
import type { ChainName } from "../../src/config.ts";
import type { RawLog } from "../../src/logs.ts";

/** RPC URLs for tests: keyed-looking paths and queries, so a test can check none of it leaks. */
export const TEST_URLS = {
  base: "https://base.rpc.test/v2/base-key-0123456789",
  baseLogs: "https://base-logs.rpc.test/rpc?apikey=logs-key-0123456789",
  bittensor: "https://bittensor.rpc.test/v1/bit-key-0123456789",
} as const;

const CHAIN_OF_HOST: Record<string, ChainName> = {
  "base.rpc.test": "base",
  "base-logs.rpc.test": "base",
  "bittensor.rpc.test": "bittensor",
};

/** How one fake chain behaves. `head` is the true head; the node serving a request may be behind it. */
export interface ChainSpec {
  head: bigint;
  /** every log on the chain; eth_getLogs answers those in range at addresses asked, up to the node's head */
  logs?: RawLog[];
  /** a block's timestamp (default: 1,700,000,000 + 12 s a block) */
  blockTime?: (n: bigint) => number;
  /** extra or replacement method handlers; `at` is the block the node serves the request at */
  calls?: Record<string, (params: unknown[], at: bigint) => unknown>;
  /** the node always answers as if its head were this many blocks lower */
  lagBy?: bigint;
  /** the next `answers` requests (fetches) are served by a node whose head is `head` */
  behindFor?: { answers: number; head: bigint };
  /** the next `count` fetches answer this HTTP status */
  failNext?: { count: number; status: number };
}

export interface FetchRecord {
  url: string;
  chain: ChainName;
  /** the methods asked, in order (one for a single request) */
  methods: string[];
  batch: boolean;
}

const toTag = (x: unknown) => (typeof x === "string" ? x : "latest");

/** A fetch that answers JSON-RPC (single requests and batches) for both chains, from `specs`, routed by
 * the TEST_URLS hosts. It records every fetch, and runs `onFetch` (e.g. to move an injected clock)
 * before answering. */
export function fakeChains(specs: Partial<Record<ChainName, ChainSpec>>, opts: { onFetch?: (r: FetchRecord) => void | Promise<void> } = {}) {
  const fetches: FetchRecord[] = [];
  const time = (spec: ChainSpec, n: bigint) => (spec.blockTime ? spec.blockTime(n) : 1_700_000_000 + Number(n) * 12);

  function answer(spec: ChainSpec, nodeHead: bigint, method: string, params: unknown[]): unknown {
    const custom = spec.calls?.[method];
    const at = (tag: unknown) => {
      const t = toTag(tag);
      return t === "latest" || t === "pending" || t === "safe" || t === "finalized" ? nodeHead : hexToBigInt(t as Hex);
    };
    if (custom) return custom(params, method === "eth_call" || method === "eth_getBalance" || method === "eth_getTransactionCount" ? at(params[1]) : nodeHead);
    switch (method) {
      case "eth_blockNumber":
        return numberToHex(nodeHead);
      case "eth_chainId":
        return "0x1";
      case "eth_getBlockByNumber": {
        const n = at(params[0]);
        if (n > nodeHead) return null;
        return { number: numberToHex(n), timestamp: numberToHex(time(spec, n)), hash: numberToHex(n, { size: 32 }) };
      }
      case "eth_getLogs": {
        const f = params[0] as { address: Hex[] | Hex; fromBlock: Hex; toBlock: Hex };
        const addresses = (Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase());
        const from = hexToBigInt(f.fromBlock);
        const to = hexToBigInt(f.toBlock);
        return (spec.logs ?? []).filter((l) => {
          const b = hexToBigInt(l.blockNumber);
          return b >= from && b <= to && b <= nodeHead && addresses.includes(l.address.toLowerCase());
        });
      }
      default:
        throw Object.assign(new Error(`the method ${method} does not exist`), { rpcCode: -32601 });
    }
  }

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const chain = CHAIN_OF_HOST[new URL(url).host];
    const spec = chain && specs[chain];
    if (!chain || !spec) throw new TypeError(`fake: nothing answers ${url}`);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const calls = Array.isArray(body) ? body : [body];
    const record: FetchRecord = { url, chain, methods: calls.map((c) => c.method), batch: Array.isArray(body) };
    fetches.push(record);
    await opts.onFetch?.(record);
    if (spec.failNext && spec.failNext.count > 0) {
      spec.failNext.count--;
      return new Response("busy", { status: spec.failNext.status });
    }
    let nodeHead = spec.head - (spec.lagBy ?? 0n);
    if (spec.behindFor && spec.behindFor.answers > 0) {
      spec.behindFor.answers--;
      nodeHead = spec.behindFor.head;
    }
    const answers = calls.map((c) => {
      try {
        return { jsonrpc: "2.0", id: c.id, result: answer(spec, nodeHead, c.method, c.params) };
      } catch (e) {
        const err = e as Error & { rpcCode?: number; rpcData?: unknown };
        return { jsonrpc: "2.0", id: c.id, error: { code: err.rpcCode ?? -32000, message: err.message, data: err.rpcData } };
      }
    });
    return Response.json(Array.isArray(body) ? answers : answers[0]);
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    fetches,
    /** fetches made to one chain */
    count: (chain?: ChainName) => fetches.filter((f) => chain === undefined || f.chain === chain).length,
  };
}

/** A clock for tests: `sleep` moves it on instead of waiting. */
export function fakeClock(startMs = 1_800_000_000_000) {
  let t = startMs;
  const slept: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}
