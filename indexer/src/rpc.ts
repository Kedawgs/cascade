import { type Hex, hexToBigInt, hexToNumber, numberToHex } from "viem";
import { type ChainName, redact } from "./config.ts";
import type { RawLog } from "./logs.ts";

/** What an invocation may still spend: external fetches (Workers Free allows 50), or logs decoded. */
export class BudgetExhausted extends Error {
  readonly limit: number;

  constructor(what: string, limit: number) {
    super(`the ${what} budget of ${limit} is spent`);
    this.name = "BudgetExhausted";
    this.limit = limit;
  }
}

export class Budget {
  readonly limit: number;
  readonly what: string;
  #spent = 0;

  constructor(limit: number, what = "subrequest") {
    this.limit = limit;
    this.what = what;
  }

  /** Takes `n` from what is left, or throws BudgetExhausted (before anything is spent or fetched). */
  spend(n = 1): void {
    if (this.#spent + n > this.limit) throw new BudgetExhausted(this.what, this.limit);
    this.#spent += n;
  }

  get left(): number {
    return this.limit - this.#spent;
  }
}

/** A failed JSON-RPC request. The message names the chain, the method and the node's registrable domain
 * only: never the URL's subdomain, path or query, where a keyed URL holds its key (and some nodes echo
 * it back). */
export class RpcError extends Error {
  readonly chain: ChainName;
  readonly method: string;
  /** the node's JSON-RPC error code (3 is a revert) */
  readonly code?: number;
  /** the HTTP status, when the request itself failed */
  readonly status?: number;
  readonly data?: unknown;
  /** it gave up at the caller's deadline (a wait or a request would have run past it) */
  readonly deadline?: boolean;

  constructor(chain: ChainName, method: string, url: string, detail: string, extra: { code?: number; status?: number; data?: unknown; deadline?: boolean } = {}) {
    super(`${chain} ${method} via ${redact(url)}: ${scrub(detail, url)}`);
    this.name = "RpcError";
    this.chain = chain;
    this.method = method;
    this.code = extra.code;
    this.status = extra.status;
    this.data = extra.data;
    this.deadline = extra.deadline;
  }
}

/** `text` with every part of `url` but its registrable domain cut out: the host and its subdomain
 * labels, the path, the query and any credentials. */
export function scrub(text: string, url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return text;
  }
  const labels = u.hostname.split(".");
  const subdomain = labels.length > 2 ? labels.slice(0, -2) : [];
  const parts = [
    url,
    u.href,
    `${u.host}${u.pathname}${u.search}`,
    `${u.pathname}${u.search}`,
    u.pathname,
    u.search,
    ...u.pathname.split("/"),
    ...[...u.searchParams].flat(),
    u.username,
    u.password,
    u.host,
    u.hostname,
    subdomain.join("."),
    ...subdomain,
  ];
  // whatever case a node echoes it in (a URL's host comes back lowercased, the key may not)
  const escaped = [...new Set(parts)]
    .filter((p) => p.length >= 4)
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return escaped.length === 0 ? text : text.replace(new RegExp(escaped.join("|"), "gi"), "…");
}

export interface Call {
  method: string;
  params: unknown[];
}

/** A call's deadline (ms on the client's clock): no wait and no request runs past it. */
export interface CallOptions {
  deadlineMs?: number;
}

export interface Rpc {
  call(chain: ChainName, method: string, params: unknown[], opts?: CallOptions): Promise<unknown>;
  batch(chain: ChainName, calls: Call[], opts?: CallOptions): Promise<unknown[]>;
  /** One window of logs and the answering node's head, in one batched request to one node (Base's
   * goes to its logs URL), so a window is accepted only from a node that has reached its end.
   * `headTime` also asks for the latest block, for its time. */
  logsWithHead(
    chain: ChainName,
    filter: { address: Hex[]; fromBlock: bigint; toBlock: bigint },
    opts?: { headTime?: boolean } & CallOptions,
  ): Promise<{ logs: RawLog[]; head: bigint; headTime?: number }>;
}

/** Where a request goes: Base has a second URL for eth_getLogs (mainnet.base.org refuses it). */
type Endpoint = ChainName | "baseLogs";

export interface RpcOptions {
  urls: Record<Endpoint, string>;
  fetch: typeof fetch;
  /** every fetch, retries included, spends one unit */
  budget: Budget;
  /** the least time between two requests to one endpoint: Base 300 ms (about 200 a minute), Bittensor 500 */
  spacingMs?: Partial<Record<ChainName, number>>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** how often an HTTP 429 or 5xx is retried, after 2, 4, 8 s */
  retries?: number;
  /** a request with no answer by then fails (and isn't retried): a hung node can't hold the tick */
  timeoutMs?: number;
  /** every call's deadline unless it gives its own (ms on `now`'s clock): a spacing wait or a backoff
   * that would end past it isn't started, and a request's timeout is cut short at it */
  deadlineMs?: number;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** JSON-RPC over fetch: the Worker's one way to a chain. Requests to one endpoint run one at a time,
 * spaced; a batch is one fetch; answers are matched by id; HTTP 429 and 5xx are retried with backoff;
 * every fetch spends the invocation's budget and has a timeout. */
export function createRpc(o: RpcOptions): Rpc {
  const spacing = { base: 300, bittensor: 500, ...o.spacingMs };
  const spacingOf = (ep: Endpoint) => (ep === "bittensor" ? spacing.bittensor : spacing.base);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const retries = o.retries ?? 3;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const last: Record<Endpoint, number> = { base: -Infinity, baseLogs: -Infinity, bittensor: -Infinity };
  const queue: Record<Endpoint, Promise<unknown>> = { base: Promise.resolve(), baseLogs: Promise.resolve(), bittensor: Promise.resolve() };
  let nextId = 0;

  function inTurn<T>(ep: Endpoint, run: () => Promise<T>): Promise<T> {
    const p = queue[ep].then(run, run);
    queue[ep] = p.catch(() => undefined);
    return p;
  }

  async function post(ep: Endpoint, chain: ChainName, label: string, body: unknown, deadlineMs: number | undefined): Promise<unknown> {
    const url = o.urls[ep];
    const late = (detail: string, status?: number) => new RpcError(chain, label, url, detail, { deadline: true, status });
    const left = () => (deadlineMs === undefined ? Infinity : deadlineMs - now());
    for (let attempt = 0; ; attempt++) {
      const wait = last[ep] + spacingOf(ep) - now();
      if (wait > 0) {
        if (wait >= left()) throw late("no time left before the deadline to space this request");
        await sleep(wait);
      }
      if (left() <= 0) throw late("no time left before the deadline");
      o.budget.spend();
      last[ep] = now();
      // the request's own timeout, cut short at the caller's deadline
      const cut = left() < timeoutMs;
      const ms = cut ? Math.max(1, Math.floor(left())) : timeoutMs;
      const signal = AbortSignal.timeout(ms);
      let res: Response;
      try {
        res = await o.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
      } catch (e) {
        if (signal.aborted) throw cut ? late("no answer before the deadline") : new RpcError(chain, label, url, `no answer within ${timeoutMs / 1000} s`);
        throw new RpcError(chain, label, url, `the request failed (${errorText(e)})`);
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        if (attempt >= retries) throw new RpcError(chain, label, url, `still answering HTTP ${res.status} after ${retries} retries`, { status: res.status });
        const backoff = 2000 * 2 ** attempt;
        if (backoff >= left()) throw late(`answering HTTP ${res.status}, with no time left before the deadline to try again`, res.status);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new RpcError(chain, label, url, `HTTP ${res.status}`, { status: res.status });
      }
      try {
        return await res.json();
      } catch {
        if (signal.aborted) throw cut ? late("no answer before the deadline") : new RpcError(chain, label, url, `no answer within ${timeoutMs / 1000} s`);
        throw new RpcError(chain, label, url, "answered with something that isn't JSON");
      }
    }
  }

  const memberError = (chain: ChainName, method: string, url: string, error: unknown) => {
    const e = isObject(error) ? error : {};
    return new RpcError(chain, method, url, typeof e.message === "string" ? e.message : "an error with no message", {
      code: typeof e.code === "number" ? e.code : undefined,
      data: e.data,
    });
  };

  const deadlineOf = (opts?: CallOptions) => opts?.deadlineMs ?? o.deadlineMs;

  function batchAt(ep: Endpoint, chain: ChainName, calls: Call[], deadlineMs: number | undefined): Promise<unknown[]> {
    if (calls.length === 0) return Promise.resolve([]);
    const url = o.urls[ep];
    const label = calls.map((c) => c.method).join("+");
    return inTurn(ep, async () => {
      const first = nextId + 1;
      const body = calls.map((c) => ({ jsonrpc: "2.0", id: ++nextId, method: c.method, params: c.params }));
      const answer = await post(ep, chain, label, body, deadlineMs);
      // a node that can't take the batch answers with one error object
      if (isObject(answer) && "error" in answer) throw memberError(chain, label, url, answer.error);
      if (!Array.isArray(answer)) throw new RpcError(chain, label, url, "answered a batch with something that isn't a list");
      const byId = new Map<unknown, Record<string, unknown>>(answer.filter(isObject).map((a) => [a.id, a]));
      return calls.map((c, i) => {
        const a = byId.get(first + i);
        if (!a) throw new RpcError(chain, c.method, url, "no answer to this call in the batch");
        if ("error" in a && a.error !== undefined && a.error !== null) throw memberError(chain, c.method, url, a.error);
        if (!("result" in a)) throw new RpcError(chain, c.method, url, "an answer with no result");
        return a.result;
      });
    });
  }

  return {
    call(chain, method, params, opts) {
      const url = o.urls[chain];
      return inTurn(chain, async () => {
        const answer = await post(chain, chain, method, { jsonrpc: "2.0", id: ++nextId, method, params }, deadlineOf(opts));
        if (!isObject(answer)) throw new RpcError(chain, method, url, "answered with something that isn't a JSON-RPC answer");
        if ("error" in answer && answer.error !== undefined && answer.error !== null) throw memberError(chain, method, url, answer.error);
        if (!("result" in answer)) throw new RpcError(chain, method, url, "an answer with no result");
        return answer.result;
      });
    },

    batch: (chain, calls, opts) => batchAt(chain, chain, calls, deadlineOf(opts)),

    async logsWithHead(chain, filter, opts = {}) {
      const ep: Endpoint = chain === "base" ? "baseLogs" : "bittensor";
      const calls: Call[] = [
        { method: "eth_getLogs", params: [{ address: filter.address, fromBlock: numberToHex(filter.fromBlock), toBlock: numberToHex(filter.toBlock) }] },
        { method: "eth_blockNumber", params: [] },
      ];
      if (opts.headTime) calls.push({ method: "eth_getBlockByNumber", params: ["latest", false] });
      const [logs, head, block] = await batchAt(ep, chain, calls, deadlineOf(opts));
      if (!Array.isArray(logs)) throw new RpcError(chain, "eth_getLogs", o.urls[ep], "answered with something that isn't a list of logs");
      if (typeof head !== "string") throw new RpcError(chain, "eth_blockNumber", o.urls[ep], "answered with something that isn't a block number");
      const time = isObject(block) && typeof block.timestamp === "string" ? hexToNumber(block.timestamp as Hex) : undefined;
      return { logs: logs as RawLog[], head: hexToBigInt(head as Hex), ...(time === undefined ? {} : { headTime: time }) };
    },
  };
}
