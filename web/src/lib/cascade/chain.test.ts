import { type Address, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, type Hex, multicall3Abi, numberToHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MULTICALL3_ABI } from "./abi";
import { createClients, YIELD_RETRIES, YIELD_TIMEOUT_MS } from "./chain";
import { type Deployment, MULTICALL3, RPC } from "./config";
import { readVault } from "./reads";

interface Rpc {
  id: number;
  method: string;
  params: unknown[];
}

/** The network: every HTTP request the clients send (the host it went to, and its body as sent: one request, or a
 * batch of them), each JSON-RPC request answered by `answer`. */
function network(answer: (r: Rpc) => unknown) {
  const posts: { host: string; body: Rpc | Rpc[] }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: { body?: string }) => {
    const request = input instanceof Request ? input : undefined;
    const host = new URL(request ? request.url : String(input)).host;
    const body = JSON.parse(request ? await request.text() : (init?.body ?? "null")) as Rpc | Rpc[];
    posts.push({ host, body });
    const reply = (r: Rpc) => ({ jsonrpc: "2.0", id: r.id, result: answer(r) });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { headers: { "Content-Type": "application/json" } });
  });
  return posts;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the site's Bittensor client", () => {
  const VAULT: Address = "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750";

  it("reads a native balance through Multicall3's getEthBalance, never eth_getBalance: the read the vault's own multicall now carries (reads.ts readVault) is the one the site made before", async () => {
    const posts = network((r) => {
      if (r.method !== "eth_call") throw new Error(`unexpected ${r.method}`);
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: [{ success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [1_000_000_000_000n]) }],
      });
    });
    const balance = await createClients().bittensor.getBalance({ address: VAULT, blockNumber: 9_400_000n });
    expect(balance).toBe(1_000_000_000_000n);
    const sent = posts.flatMap((p) => (Array.isArray(p.body) ? p.body : [p.body]));
    expect(sent.map((r) => r.method)).toEqual(["eth_call"]);
    const [call, block] = sent[0].params as [{ to: Address; data: Hex }, string];
    // at the block asked for, to Multicall3 on Bittensor
    expect(BigInt(block)).toBe(9_400_000n);
    expect(call.to.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    const outer = decodeFunctionData({ abi: multicall3Abi, data: call.data });
    expect(outer.functionName).toBe("aggregate3");
    const [calls] = outer.args as unknown as [readonly { target: Address; callData: Hex }[]];
    expect(calls).toHaveLength(1);
    expect(calls[0].target.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    // the very function, and argument, readVault's multicall asks beside the vault's figures
    expect(decodeFunctionData({ abi: MULTICALL3_ABI, data: calls[0].callData })).toEqual({ functionName: "getEthBalance", args: [VAULT] });
  });
});

describe("the vault's read (reads.ts readVault), on the site's Bittensor client", () => {
  const D32: Deployment = {
    frontDoor: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
    baseAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
    vault: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
    bitAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
    bitBlock: 9357492n,
    vaultSs58: "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu",
    hotkeySs58: "5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde",
    staker: "0x00000000000000000000000000000000005A4E12",
    oracle: "0x000000000000000000000000000000000000041E",
    vaultLens: "0x000000000000000000000000000000000000Ae15",
    doorLens: "0x000000000000000000000000000000000000De15",
  };
  const TIP = 9_400_000n;
  const BLOCK_NUMBER = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "getBlockNumber" });
  const word = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);

  /** Bittensor's node: the newest header (a block made just now), and every multicall answered at that block, each of
   * its calls with 1 (a uint, a bool or 32 bytes, as its getter returns). */
  function node() {
    return network((r) => {
      if (r.method === "eth_getBlockByNumber") return { number: numberToHex(TIP), timestamp: numberToHex(Math.floor(Date.now() / 1000)), hash: `0x${"11".repeat(32)}`, transactions: [] };
      if (r.method !== "eth_call") throw new Error(`unexpected ${r.method}`);
      const [call] = r.params as [{ data: Hex }];
      const [calls] = decodeFunctionData({ abi: multicall3Abi, data: call.data }).args as unknown as [readonly { callData: Hex }[]];
      return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: calls.map((c) => ({ success: true, returnData: word(c.callData === BLOCK_NUMBER ? TIP : 1n) })) });
    });
  }
  const sent = (posts: ReturnType<typeof node>) => posts.flatMap((p) => (Array.isArray(p.body) ? p.body : [p.body]));

  it("is the newest header and one call for everything else (the figures, the balance, the block they were read at), both at the newest block: nothing asked after either answers", async () => {
    const posts = node();
    const v = await readVault({ bittensor: createClients().bittensor }, D32, "0x000000000000000000000000000000000000a11c");
    expect(v).toMatchObject({ shares: 1n, totalAssets: 1n, balanceWei: 1n, stakeMissing: true });
    const requests = sent(posts);
    expect(requests.map((r) => r.method).sort()).toEqual(["eth_call", "eth_getBlockByNumber"]);
    const call = requests.find((r) => r.method === "eth_call")!;
    expect(call.params[1]).toBe("latest");
    const [calls] = decodeFunctionData({ abi: multicall3Abi, data: (call.params[0] as { data: Hex }).data }).args as unknown as [readonly { target: Address; callData: Hex }[]];
    // the block the calls run at is asked first and last, and the vault's balance among them
    expect(calls[0].callData).toBe(BLOCK_NUMBER);
    expect(calls.at(-1)!.callData).toBe(BLOCK_NUMBER);
    expect(calls.map((c) => c.callData)).toContain(encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "getEthBalance", args: [D32.vault] }));
  });

  it("stays one call however many accounts' reads go at once: never split by size, where a split could be answered at two blocks", async () => {
    const posts = node();
    const c = createClients();
    const accounts = Array.from({ length: 9 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
    await Promise.all(accounts.map((a) => readVault({ bittensor: c.bittensor }, D32, a)));
    const calls = sent(posts).filter((r) => r.method === "eth_call");
    expect(calls).toHaveLength(1);
    // well over the 1,024 bytes of calldata viem's batches split at by default
    const [inner] = decodeFunctionData({ abi: multicall3Abi, data: (calls[0].params[0] as { data: Hex }).data }).args as unknown as [readonly { callData: Hex }[]];
    expect(inner.reduce((bytes, x) => bytes + (x.callData.length - 2) / 2, 0)).toBeGreaterThan(1_024);
    expect(inner).toHaveLength(9 * 15);
  });
});

describe("the screens' connections", () => {
  it("wait viem's 10 s for an answer in the browser; the build's snapshot gives them longer (snapshot.ts), and the yield's and the pre-send check's keep their own", () => {
    const browser = createClients();
    for (const client of [browser.base, browser.baseLogs, browser.bittensor]) expect(client.transport.timeout).toBe(10_000);
    const build = createClients({ timeoutMs: 30_000 });
    for (const client of [build.base, build.baseLogs, build.bittensor]) {
      expect(client.transport.timeout).toBe(30_000);
      expect(client.transport.retryCount).toBe(4);
    }
    expect(build.baseCheck.transport.timeout).toBe(3_000);
    expect(build.bittensorHistory.transport.timeout).toBe(10_000);
    expect(build.bittensorYield.transport.timeout).toBe(90_000);
    expect(build.bittensorDeep.transport.timeout).toBe(90_000);
  });
});

describe("the yield's two connections to Bittensor's archive node", () => {
  it("wait a minute and a half for an answer, and ask once more at most", () => {
    const c = createClients();
    expect(YIELD_TIMEOUT_MS).toBe(90_000);
    expect(YIELD_RETRIES).toBe(1);
    for (const client of [c.bittensorYield, c.bittensorDeep]) {
      expect(client.transport.timeout).toBe(90_000);
      expect(client.transport.retryCount).toBe(1);
      expect(client.transport.url).toBe(RPC.bittensor);
    }
    // the connections the screens read on keep their own, shorter waits
    expect(c.bittensorHistory.transport.timeout).toBe(10_000);
  });

  it("the deep one never batches: two requests made together travel as two, each alone", async () => {
    const posts = network((r) => (r.method === "eth_chainId" ? "0x3c4" : "0x8f6f40"));
    const c = createClients();
    await Promise.all([c.bittensorDeep.request({ method: "eth_blockNumber" }), c.bittensorDeep.request({ method: "eth_chainId" })]);
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => !Array.isArray(p.body) && p.host === new URL(RPC.bittensor).host)).toBe(true);
  });

  it("the other batches today's reads among themselves: two requests made together travel as one", async () => {
    const posts = network((r) => (r.method === "eth_chainId" ? "0x3c4" : "0x8f6f40"));
    const c = createClients();
    await Promise.all([c.bittensorYield.request({ method: "eth_blockNumber" }), c.bittensorYield.request({ method: "eth_chainId" })]);
    expect(posts).toHaveLength(1);
    expect(Array.isArray(posts[0].body) && posts[0].body.map((r) => r.method).sort()).toEqual(["eth_blockNumber", "eth_chainId"]);
  });
});
