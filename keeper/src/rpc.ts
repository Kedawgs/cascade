import { type Address, decodeFunctionResult, encodeFunctionData, type Hex, hexToBigInt, numberToHex, parseAbi } from "viem";
import { createRpc, logsRpc, type Rpc, RpcError } from "../../ops/src/keeper/core/rpc.ts";
import type { ChainName } from "../../ops/src/keeper/core/types.ts";
import type { KeeperConfig } from "./config.ts";

// The Worker's RPC (design-keeper-worker.md §5): the core's fetch-based Rpc, every fetch counted (a subrequest), a
// budget a run can't go over, and its reads batched into one Multicall3 eth_call a chain. Keyed URLs are secrets: no
// line here quotes a URL, and every line the Worker logs is scrubbed (scrubSecrets) besides.

/** The run's subrequest budget is spent: the read is refused, and the round fails ("try again", never "wrong"). */
export class BudgetSpent extends RpcError {}

/** The run's 90 s for reading are up (the review's Important 3): nothing more is asked, and the round fails soft, so the
 * run commits what it read (its log cursors too) well inside its lease. */
export class ReadDeadline extends RpcError {}

/** The run's lease could not be renewed (lost, run out, or the kill switch on): nothing more is read or sent. */
export class LeaseGone extends RpcError {}

/** A request no answer came back to in time (the re-review's N8): given up, a wait like any RPC error, so a hung node can
 * never hold a run past its deadline and its lease. */
export class RequestTimeout extends RpcError {}

/** How long one request may take, its answer read in full: a run's 90 s for reading, then at most this, stays inside its
 * 120 s lease (renewed every 30 s while it reads). */
export const REQUEST_TIMEOUT_MS = 20_000;

/** `f` with every request given up after `ms` (RequestTimeout, `what` naming it): the fetch is aborted, and its answer is
 * read in full within the same time, so a node that answers its headers and then hangs is given up too. */
export function withTimeout(f: typeof fetch, ms: number, what: (input: string | URL | Request, init?: RequestInit) => string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new RequestTimeout(`${what(input, init)}: no answer in ${ms / 1000} s; given up, the next run asks again`));
      }, ms);
    });
    const asked = (async () => {
      const res = await f(input as never, { ...init, signal: init?.signal ?? ctl.signal });
      const body = await res.text();
      // (a status that carries no body takes none back)
      return new Response([101, 103, 204, 205, 304].includes(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
    })();
    try {
      return await Promise.race([asked, late]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // an answer that comes after the timeout is let go of
      asked.catch(() => undefined);
    }
  }) as typeof fetch;
}

/** The methods a send uses (the guard, the estimate, the fees, the broadcast and its receipt): never refused by the
 * budget until RESERVE more have been used, so a send under way is never cut off half way by it. */
const SEND_PATH = new Set([
  "eth_chainId",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
]);
export const RESERVE = 100;
/** About what one send asks the RPC: the guard, the estimate, the fees, the code checks, the broadcast, its receipt's
 * polls over 40 s and a revert's replay. A send isn't started with fewer left (the review's Minor 3). */
export const SEND_NEEDS = 30;

/** How many fetches (subrequests) the run has made, by chain and in all. */
export interface Meter {
  count: number;
  byChain: Record<ChainName, number>;
  byMethod: Record<string, number>;
  budget: number;
}

export const meter = (budget: number): Meter => ({ count: 0, byChain: { base: 0, bittensor: 0 }, byMethod: {}, budget });

/** `inner` behind the run's budget: a read refused once the budget is spent (a send's own requests get RESERVE more), and
 * `guard` (the run's deadline and its lease) before every request. The meter counts fetches (countingFetch), so a 429's
 * retry counts too. A broadcast is never refused (the review's W3): it follows its write-ahead, so its transaction is
 * signed and journaled by then, and its row's "sent" must be true; it is counted all the same, one a send. */
export function metered(inner: Rpc, m: Meter, guard: (chain: ChainName, method: string) => Promise<void> = async () => undefined): Rpc {
  return {
    async request(chain, method, params) {
      const cap = SEND_PATH.has(method) ? m.budget + RESERVE : m.budget;
      if (m.count >= cap && method !== "eth_sendRawTransaction") throw new BudgetSpent(`the run's ${m.budget} RPC requests (KEEPER_SUBREQUEST_BUDGET) are spent: ${chain} ${method} not asked; the next run reads on`);
      await guard(chain, method);
      return inner.request(chain, method, params);
    },
  };
}

const methodOf = (init?: RequestInit): string => {
  try {
    return (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method ?? "?";
  } catch {
    // not JSON-RPC
    return "?";
  }
};

/** `f`, each fetch (each subrequest, a retry included) counted on `m`, by chain (`chainOf` its URL) and method, and given
 * up after `timeoutMs` (withTimeout). */
export function countingFetch(f: typeof fetch, m: Meter, chainOf: (url: string) => ChainName, timeoutMs = REQUEST_TIMEOUT_MS): typeof fetch {
  const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  // the URL is never named (a keyed one is a secret): its chain and the method only
  const timed = withTimeout(f, timeoutMs, (input, init) => `${chainOf(urlOf(input)) === "base" ? "Base" : "Bittensor"} ${methodOf(init)}`);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    m.count++;
    m.byChain[chainOf(urlOf(input))]++;
    const method = methodOf(init);
    m.byMethod[method] = (m.byMethod[method] ?? 0) + 1;
    return timed(input as never, init);
  }) as typeof fetch;
}

const MULTICALL_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);

/** Which reads a run made, by chain, so the next run's first read can batch them: each key with the run it was last
 * seen in. */
export interface Learned {
  run: number;
  keys: Record<ChainName, Record<string, number>>;
}

export const freshLearned = (): Learned => ({ run: 0, keys: { base: {}, bittensor: {} } });

/** A read's key: an eth_call of a plain {to, data} at the latest block, or an address's balance there. */
function keyOf(method: string, params: unknown[]): string | undefined {
  if (params[1] !== "latest") return undefined;
  if (method === "eth_getBalance" && typeof params[0] === "string") return `b:${params[0].toLowerCase()}`;
  if (method !== "eth_call") return undefined;
  const c = params[0] as Record<string, unknown> | undefined;
  if (!c || typeof c.to !== "string" || typeof c.data !== "string") return undefined;
  if (Object.keys(c).some((k) => k !== "to" && k !== "data")) return undefined;
  return `c:${c.to.toLowerCase()}:${c.data.toLowerCase()}`;
}

/** Keys a run batches at most, and the longest one (a quote over a full batch's message is a few KB) */
const MAX_KEYS = 120;
const MAX_KEY_LENGTH = 2_400;
/** A batch answers reads for this long, and until the run estimates or broadcasts anything on either chain: what is
 * read after a send (the round's re-read of a lost race, a close's re-read after a refused simulation) is fresh. */
const SNAPSHOT_MS = 15_000;
/** A key not read for this many runs is let go of */
const KEEP_RUNS = 3;

type Snapshot = { at: number; results: Map<string, { ok: boolean; data: Hex }> };

/** `inner` with its reads batched: the first read of a chain (or the first after a send) asks Multicall3's aggregate3
 * for it and every read the last runs made, all at one block, and later reads of that batch are answered from it.
 * A read the batch couldn't answer (it reverted inside, or it is new) goes to `inner` as it is, so its answer, or its
 * error, is exactly the node's. A batch that fails as a whole turns batching off for the run, said once. */
export function batched(inner: Rpc, o: { learned: Learned; now: () => number; log: (line: string) => void; multicall3: Address }) {
  const run = o.learned.run + 1;
  const keys: Record<ChainName, Record<string, number>> = { base: { ...o.learned.keys.base }, bittensor: { ...o.learned.keys.bittensor } };
  const snapshots: Partial<Record<ChainName, Snapshot>> = {};
  const off: Partial<Record<ChainName, boolean>> = {};
  const stats = { batches: 0, answered: 0, direct: 0 };

  const encode = (key: string) =>
    key.startsWith("b:")
      ? { target: o.multicall3, allowFailure: true, callData: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "getEthBalance", args: [key.slice(2) as Address] }) }
      : { target: key.slice(2, 44) as Address, allowFailure: true, callData: key.slice(45) as Hex };

  async function batch(chain: ChainName, first: string): Promise<Snapshot | undefined> {
    const list = [first, ...Object.entries(keys[chain]).filter(([k, at]) => k !== first && at >= run - KEEP_RUNS).map(([k]) => k)].slice(0, MAX_KEYS);
    if (list.length < 2) return undefined;
    try {
      const data = encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [list.map(encode)] });
      const out = (await inner.request(chain, "eth_call", [{ to: o.multicall3, data }, "latest"])) as Hex;
      const answers = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: out });
      if (answers.length !== list.length) throw new Error(`${answers.length} answers to ${list.length} reads`);
      const results = new Map<string, { ok: boolean; data: Hex }>();
      list.forEach((k, i) => results.set(k, { ok: answers[i].success, data: answers[i].returnData }));
      stats.batches++;
      return { at: o.now(), results };
    } catch (e) {
      if (e instanceof BudgetSpent) throw e;
      off[chain] = true;
      o.log(`${chain === "base" ? "Base" : "Bittensor"}: reading through Multicall3 failed (${(e as Error).message.split("\n")[0]}); this run reads one by one`);
      return undefined;
    }
  }

  const rpc: Rpc = {
    async request(chain, method, params) {
      if (method === "eth_sendRawTransaction" || method === "eth_estimateGas") {
        delete snapshots.base;
        delete snapshots.bittensor;
        return inner.request(chain, method, params);
      }
      const key = keyOf(method, params);
      if (!key || key.length > MAX_KEY_LENGTH) return inner.request(chain, method, params);
      keys[chain][key] = run;
      let s = snapshots[chain];
      if (s && o.now() - s.at >= SNAPSHOT_MS) s = undefined;
      if (!s && !off[chain]) {
        s = await batch(chain, key);
        if (s) snapshots[chain] = s;
      }
      const hit = s?.results.get(key);
      if (hit?.ok) {
        stats.answered++;
        return key.startsWith("b:") ? numberToHex(decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "getEthBalance", data: hit.data })) : hit.data;
      }
      stats.direct++;
      return inner.request(chain, method, params);
    },
  };
  return {
    rpc,
    stats,
    /** What the next run starts from: the keys read within the last KEEP_RUNS runs, the newest first, at most MAX_KEYS */
    learned(): Learned {
      const keep = (c: ChainName) =>
        Object.fromEntries(
          Object.entries(keys[c])
            .filter(([, at]) => at >= run - KEEP_RUNS + 1)
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_KEYS),
        );
      return { run, keys: { base: keep("base"), bittensor: keep("bittensor") } };
    },
  };
}

/** The run's two RPCs over `fetch`: `rpc` for reads and sends (metered, batched) and `logs` for log scans (Base's on
 * its own logs server, Bittensor's on the main, archive, node), and the meter. Spacing between requests is per chain
 * (RPC_SPACING_MS); a 429 is asked again up to three times, 2 s apart: a node that turns away one request in ten (the
 * live keeper's Bittensor node did, all day, 2026-11-19) failed almost every long round on one retry, and held the first
 * mainnet payout for an hour. The run's deadline and lease still end a run that is too slow (the guard, before every
 * request), and each asking counts in the subrequest budget. */
export function runRpc(
  cfg: KeeperConfig,
  o: {
    fetch?: typeof fetch;
    learned: Learned;
    now: () => number;
    log: (line: string) => void;
    multicall3: Address;
    guard?: (chain: ChainName, method: string) => Promise<void>;
    requestTimeoutMs?: number;
  },
) {
  const m = meter(cfg.subrequestBudget);
  const chainOf = (url: string): ChainName => (url === cfg.urls.bittensor ? "bittensor" : "base");
  // the global fetch is looked up per request (so a test's spy is seen), each one counted and given up if it hangs
  const f = countingFetch((input, init) => (o.fetch ?? fetch)(input, init), m, chainOf, o.requestTimeoutMs);
  const opts = { minIntervalMs: cfg.spacingMs, retries: 3, backoffMs: 2_000, fetch: f };
  const main = metered(createRpc({ base: { rpcUrl: cfg.urls.base }, bittensor: { rpcUrl: cfg.urls.bittensor } }, opts), m, o.guard);
  const baseLogs = metered(createRpc({ base: { rpcUrl: cfg.urls.baseLogs }, bittensor: { rpcUrl: cfg.urls.bittensor } }, opts), m, o.guard);
  const b = batched(main, { learned: o.learned, now: o.now, log: o.log, multicall3: o.multicall3 });
  const logs = logsRpc(b.rpc, baseLogs, { baseChainId: cfg.deployment.chainIds.base });
  return { rpc: b.rpc, logs, meter: m, batches: b };
}

/** A plain metered RPC for the status route's few reads (no batching). */
export function statusRpc(cfg: KeeperConfig): Rpc {
  const m = meter(40);
  const f = countingFetch((input, init) => fetch(input, init), m, (url) => (url === cfg.urls.bittensor ? "bittensor" : "base"));
  return metered(createRpc({ base: { rpcUrl: cfg.urls.base }, bittensor: { rpcUrl: cfg.urls.bittensor } }, { retries: 0, fetch: f }), m);
}

export const hexBalance = (v: unknown): bigint => hexToBigInt(v as Hex);
