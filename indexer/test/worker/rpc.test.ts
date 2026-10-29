import { type Hex, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { getJson, getText, HttpError } from "../../src/http.ts";
import { Budget, BudgetExhausted, createRpc, RpcError, scrub } from "../../src/rpc.ts";
import { fakeChains, fakeClock, TEST_URLS } from "./fake-rpc.ts";

const quiet = { sleep: async () => {}, spacingMs: { base: 0, bittensor: 0 } };

/** Every secret-looking part of the test URLs: none may appear in an error. */
const SECRETS = ["base-key-0123456789", "logs-key-0123456789", "bit-key-0123456789", "/v2/", "apikey", "/v1/"];
const leaks = (message: string) => SECRETS.filter((s) => message.includes(s));

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("it resolved");
}

describe("Budget", () => {
  it("counts down and refuses past its limit", () => {
    const b = new Budget(2);
    b.spend();
    expect(b.left).toBe(1);
    b.spend();
    expect(() => b.spend()).toThrow(BudgetExhausted);
    expect(b.left).toBe(0);
  });
});

describe("createRpc", () => {
  it("sends a batch of three calls as one fetch, one budget unit", async () => {
    const net = fakeChains({ bittensor: { head: 100n } });
    const budget = new Budget(45);
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget, ...quiet });
    const out = await rpc.batch("bittensor", [
      { method: "eth_blockNumber", params: [] },
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: ["0x5", false] },
    ]);
    expect(net.count()).toBe(1);
    expect(budget.left).toBe(44);
    expect(out[0]).toBe("0x64");
    expect((out[2] as { number: Hex }).number).toBe("0x5");
  });

  it("matches answers to calls by id, whatever order they come back in", async () => {
    const reversed = async (_: RequestInfo | URL, init?: RequestInit) => {
      const calls = JSON.parse(String(init!.body)) as { id: number; method: string }[];
      return Response.json(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: c.method })).reverse());
    };
    const rpc = createRpc({ urls: TEST_URLS, fetch: reversed as typeof fetch, budget: new Budget(45), ...quiet });
    expect(await rpc.batch("base", [{ method: "a", params: [] }, { method: "b", params: [] }, { method: "c", params: [] }])).toEqual(["a", "b", "c"]);
  });

  it("retries a 429 after a 2-second backoff", async () => {
    const net = fakeChains({ base: { head: 10n, failNext: { count: 1, status: 429 } } });
    const clock = fakeClock();
    const budget = new Budget(45);
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget, sleep: clock.sleep, now: clock.now, spacingMs: { base: 0, bittensor: 0 } });
    expect(await rpc.call("base", "eth_blockNumber", [])).toBe("0xa");
    expect(clock.slept).toEqual([2000]);
    expect(budget.left).toBe(43);
  });

  it("retries a 5xx, but not a 4xx other than 429", async () => {
    const net = fakeChains({ base: { head: 10n, failNext: { count: 2, status: 503 } } });
    const clock = fakeClock();
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget: new Budget(45), sleep: clock.sleep, now: clock.now, spacingMs: { base: 0, bittensor: 0 } });
    expect(await rpc.call("base", "eth_blockNumber", [])).toBe("0xa");
    expect(clock.slept).toEqual([2000, 4000]);

    const refused = fakeChains({ base: { head: 10n, failNext: { count: 1, status: 403 } } });
    const rpc2 = createRpc({ urls: TEST_URLS, fetch: refused.fetch, budget: new Budget(45), ...quiet });
    const e = await rejection(rpc2.call("base", "eth_blockNumber", []));
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).status).toBe(403);
    expect(refused.count()).toBe(1);
  });

  it("gives up after four 429s with an error that names neither the URL's path nor its query", async () => {
    for (const [chain, url] of [["base", TEST_URLS.base], ["bittensor", TEST_URLS.bittensor]] as const) {
      const net = fakeChains({ [chain]: { head: 10n, failNext: { count: 4, status: 429 } } });
      const clock = fakeClock();
      const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget: new Budget(45), sleep: clock.sleep, now: clock.now, spacingMs: { base: 0, bittensor: 0 } });
      const e = await rejection(rpc.call(chain, "eth_blockNumber", []));
      expect(e).toBeInstanceOf(RpcError);
      expect(clock.slept).toEqual([2000, 4000, 8000]);
      expect(net.count()).toBe(4);
      expect(leaks(e.message)).toEqual([]);
      // the registrable domain only, not the host's subdomain
      expect(e.message).toContain("via rpc.test:");
      expect(e.message).not.toContain(new URL(url).host);
    }
  });

  it("never prints a key that sits in the host's subdomain, even when the node echoes it", async () => {
    const url = "https://SECRETKEY123.base-mainnet.quiknode.pro/x";
    const echo = async () =>
      Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `rate limited for ${url} (host SECRETKEY123.base-mainnet.quiknode.pro, key SECRETKEY123)` } });
    const rpc = createRpc({ urls: { ...TEST_URLS, base: url }, fetch: echo as typeof fetch, budget: new Budget(45), ...quiet });
    const e = await rejection(rpc.call("base", "eth_blockNumber", []));
    expect(e).toBeInstanceOf(RpcError);
    expect(e.message).toContain("via quiknode.pro:");
    expect(e.message).not.toMatch(/SECRETKEY123|base-mainnet/);

    const failing = async () => new Response("no", { status: 403 });
    const rpc2 = createRpc({ urls: { ...TEST_URLS, base: url }, fetch: failing as typeof fetch, budget: new Budget(45), ...quiet });
    const e2 = await rejection(rpc2.call("base", "eth_blockNumber", []));
    expect(e2.message).not.toMatch(/SECRETKEY123|base-mainnet/);
  });

  it("refuses to fetch once the budget is spent", async () => {
    const net = fakeChains({ base: { head: 10n } });
    const budget = new Budget(1);
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget, ...quiet });
    await rpc.call("base", "eth_blockNumber", []);
    await expect(rpc.call("base", "eth_blockNumber", [])).rejects.toThrow(BudgetExhausted);
    expect(net.count()).toBe(1);
  });

  it("spaces two Base requests at least 300 ms apart, and Bittensor's 500", async () => {
    const clock = fakeClock();
    const at: Record<string, number[]> = { base: [], bittensor: [] };
    const net = fakeChains({ base: { head: 10n }, bittensor: { head: 10n } }, { onFetch: (r) => void at[r.chain].push(clock.now()) });
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget: new Budget(45), sleep: clock.sleep, now: clock.now });
    await rpc.call("base", "eth_blockNumber", []);
    await rpc.call("base", "eth_blockNumber", []);
    await rpc.call("bittensor", "eth_blockNumber", []);
    await rpc.call("bittensor", "eth_blockNumber", []);
    expect(at.base[1] - at.base[0]).toBeGreaterThanOrEqual(300);
    expect(at.bittensor[1] - at.bittensor[0]).toBeGreaterThanOrEqual(500);
  });

  it("spaces calls made at the same time, one after another", async () => {
    const clock = fakeClock();
    const at: number[] = [];
    const net = fakeChains({ base: { head: 10n } }, { onFetch: () => void at.push(clock.now()) });
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget: new Budget(45), sleep: clock.sleep, now: clock.now });
    await Promise.all([rpc.call("base", "eth_blockNumber", []), rpc.call("base", "eth_blockNumber", []), rpc.call("base", "eth_blockNumber", [])]);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(300);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(300);
  });

  it("asks for logs and the head in one request, to the Base logs URL for Base", async () => {
    const net = fakeChains({ base: { head: 250n }, bittensor: { head: 1234n } });
    const budget = new Budget(45);
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget, ...quiet });
    const base = await rpc.logsWithHead("base", { address: ["0x0000000000000000000000000000000000000001"], fromBlock: 100n, toBlock: 199n });
    expect(base.head).toBe(250n);
    expect(base.logs).toEqual([]);
    expect(net.fetches[0]).toMatchObject({ url: TEST_URLS.baseLogs, batch: true, methods: ["eth_getLogs", "eth_blockNumber"] });
    const bit = await rpc.logsWithHead("bittensor", { address: ["0x0000000000000000000000000000000000000001"], fromBlock: 0n, toBlock: 999n }, { headTime: true });
    expect(bit.head).toBe(1234n);
    expect(bit.headTime).toBe(1_700_000_000 + 1234 * 12);
    expect(net.fetches[1]).toMatchObject({ url: TEST_URLS.bittensor, methods: ["eth_getLogs", "eth_blockNumber", "eth_getBlockByNumber"] });
    expect(budget.left).toBe(43);
    // other Base reads go to the main Base URL
    await rpc.call("base", "eth_blockNumber", []);
    expect(net.fetches[2].url).toBe(TEST_URLS.base);
  });

  it("returns the head of the node that answered the logs, even when it is behind", async () => {
    const net = fakeChains({ bittensor: { head: 3000n, behindFor: { answers: 1, head: 2500n } } });
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget: new Budget(45), ...quiet });
    const r = await rpc.logsWithHead("bittensor", { address: ["0x0000000000000000000000000000000000000001"], fromBlock: 2000n, toBlock: 2999n });
    expect(r.head).toBe(2500n);
  });

  it("throws an RpcError with the node's code for an error member, scrubbed of the URL's key", async () => {
    const net = fakeChains({
      bittensor: {
        head: 10n,
        calls: {
          eth_call: () => {
            throw Object.assign(new Error(`execution reverted (key bit-key-0123456789 over quota)`), { rpcCode: 3, rpcData: "0x08c379a0" });
          },
        },
      },
    });
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget: new Budget(45), ...quiet });
    const e = (await rejection(rpc.batch("bittensor", [{ method: "eth_blockNumber", params: [] }, { method: "eth_call", params: [{}, "latest"] }]))) as RpcError;
    expect(e).toBeInstanceOf(RpcError);
    expect([e.chain, e.method, e.code, e.data]).toEqual(["bittensor", "eth_call", 3, "0x08c379a0"]);
    expect(e.message).toContain("execution reverted");
    expect(leaks(e.message)).toEqual([]);
  });

  it("gives up on a node that doesn't answer within the timeout, without retrying", async () => {
    let calls = 0;
    const hung = (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        calls++;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
      });
    const rpc = createRpc({ urls: TEST_URLS, fetch: hung as typeof fetch, budget: new Budget(45), timeoutMs: 20, ...quiet });
    const e = await rejection(rpc.call("bittensor", "eth_blockNumber", []));
    expect(e).toBeInstanceOf(RpcError);
    expect(e.message).toMatch(/no answer within/);
    expect(leaks(e.message)).toEqual([]);
    expect(calls).toBe(1);
  });

  it("never sleeps for a backoff that would end past the deadline", async () => {
    const net = fakeChains({ base: { head: 10n, failNext: { count: 1, status: 429 } } });
    const clock = fakeClock();
    const deadline = clock.now() + 1500;
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget: new Budget(45), sleep: clock.sleep, now: clock.now, spacingMs: { base: 0, bittensor: 0 } });
    const e = (await rejection(rpc.call("base", "eth_blockNumber", [], { deadlineMs: deadline }))) as RpcError;
    expect(e).toBeInstanceOf(RpcError);
    expect([e.deadline, e.status]).toEqual([true, 429]);
    expect(clock.slept).toEqual([]);
    expect(clock.now()).toBeLessThanOrEqual(deadline);
  });

  it("takes the deadline from the client unless a call gives its own", async () => {
    const clock = fakeClock();
    const net = fakeChains({ base: { head: 10n, failNext: { count: 1, status: 429 } } });
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget: new Budget(45), sleep: clock.sleep, now: clock.now, spacingMs: { base: 0, bittensor: 0 }, deadlineMs: clock.now() + 1000 });
    expect(((await rejection(rpc.call("base", "eth_blockNumber", []))) as RpcError).deadline).toBe(true);
    const net2 = fakeChains({ base: { head: 10n, failNext: { count: 1, status: 429 } } });
    const rpc2 = createRpc({ urls: TEST_URLS, fetch: net2.fetch, budget: new Budget(45), sleep: clock.sleep, now: clock.now, spacingMs: { base: 0, bittensor: 0 }, deadlineMs: clock.now() + 1000 });
    expect(await rpc2.call("base", "eth_blockNumber", [], { deadlineMs: clock.now() + 60_000 })).toBe("0xa");
  });

  it("never waits out the spacing past the deadline, and spends nothing then", async () => {
    const clock = fakeClock();
    const net = fakeChains({ bittensor: { head: 10n } });
    const budget = new Budget(45);
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget, sleep: clock.sleep, now: clock.now });
    await rpc.call("bittensor", "eth_blockNumber", []);
    const e = (await rejection(rpc.call("bittensor", "eth_blockNumber", [], { deadlineMs: clock.now() + 100 }))) as RpcError;
    expect(e.deadline).toBe(true);
    expect([net.count(), budget.left]).toEqual([1, 44]);
  });

  it("cuts a request's timeout short at the deadline", async () => {
    const hung = (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
    const rpc = createRpc({ urls: TEST_URLS, fetch: hung as typeof fetch, budget: new Budget(45), timeoutMs: 20_000, ...quiet });
    const started = Date.now();
    const e = (await rejection(rpc.call("bittensor", "eth_blockNumber", [], { deadlineMs: Date.now() + 150 }))) as RpcError;
    expect(e.deadline).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("turns a network failure into an RpcError that doesn't repeat the URL", async () => {
    const broken = async (input: RequestInfo | URL) => {
      throw new TypeError(`fetch failed: ${String(input)}`);
    };
    const rpc = createRpc({ urls: TEST_URLS, fetch: broken as typeof fetch, budget: new Budget(45), ...quiet });
    const e = await rejection(rpc.call("base", "eth_blockNumber", []));
    expect(e).toBeInstanceOf(RpcError);
    expect(leaks(e.message)).toEqual([]);
  });

  it("refuses an answer that isn't a batch's, or lacks a call", async () => {
    const single = async () => Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large" } });
    const rpc = createRpc({ urls: TEST_URLS, fetch: single as typeof fetch, budget: new Budget(45), ...quiet });
    const e = (await rejection(rpc.batch("base", [{ method: "eth_blockNumber", params: [] }]))) as RpcError;
    expect([e.constructor, e.code]).toEqual([RpcError, -32600]);

    const short = async () => Response.json([]);
    const rpc2 = createRpc({ urls: TEST_URLS, fetch: short as typeof fetch, budget: new Budget(45), ...quiet });
    expect(await rejection(rpc2.batch("base", [{ method: "eth_blockNumber", params: [] }]))).toBeInstanceOf(RpcError);
  });

  it("sends nothing for an empty batch", async () => {
    const net = fakeChains({ base: { head: 1n } });
    const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget: new Budget(45), ...quiet });
    expect(await rpc.batch("base", [])).toEqual([]);
    expect(net.count()).toBe(0);
    expect(numberToHex(1n)).toBe("0x1");
  });
});

describe("scrub", () => {
  it("cuts the URL's long parts (8+ characters) and leaves short words in a node's message readable", () => {
    const url = "https://base-mainnet.quiknode.pro/chain/abcdefgh12345678?k=v&token=0123456789abcdef";
    const said = "execution reverted on chain mainnet: base fee too low (abcdefgh12345678, token 0123456789abcdef, host base-mainnet.quiknode.pro)";
    const out = scrub(said, url);
    expect(out).toContain("execution reverted on chain mainnet: base fee too low");
    expect(out).not.toMatch(/abcdefgh12345678|0123456789abcdef|base-mainnet/);
  });
});

describe("getJson and getText", () => {
  it("spend one budget unit each and pass a timeout signal", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const f = async (input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return String(input).endsWith(".json") ? Response.json({ bittensor: { usd: 400.5 } }) : new Response("<html>");
    };
    const budget = new Budget(2);
    expect(await getJson("https://prices.test/p.json", { fetch: f as typeof fetch, budget, timeoutMs: 5000 })).toEqual({ bittensor: { usd: 400.5 } });
    expect(await getText("https://site.test/", { fetch: f as typeof fetch, budget, timeoutMs: 5000 })).toBe("<html>");
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    await expect(getText("https://site.test/", { fetch: f as typeof fetch, budget, timeoutMs: 5000 })).rejects.toThrow(BudgetExhausted);
  });

  it("throw an HttpError naming only the host on a non-200 or bad JSON", async () => {
    const f = async (input: RequestInfo | URL) => (String(input).includes("bad") ? new Response("not json") : new Response("nope", { status: 404 }));
    const e = await rejection(getJson("https://prices.test/v2/key-abcdef/x?k=secret1", { fetch: f as typeof fetch, budget: new Budget(5), timeoutMs: 5000 }));
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(404);
    expect(e.message).toContain("prices.test");
    expect(e.message).not.toMatch(/key-abcdef|secret1/);
    const bad = await rejection(getJson("https://prices.test/bad", { fetch: f as typeof fetch, budget: new Budget(5), timeoutMs: 5000 }));
    expect(bad).toBeInstanceOf(HttpError);
  });
});
