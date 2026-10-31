import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, numberToHex, parseAbi, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_V3, baseLogsTarget, baseLogsWindow, type ChainName } from "../src/config.ts";
import { KEEPER_READ_ABIS, keeperDeps, scanLogs } from "../src/keeper/state.ts";
import { buildPlanV3 } from "../src/plan.ts";
import { logProbe } from "../src/preflight.ts";
import { scanRegistry } from "../src/registry.ts";
import { logsRpc, type Rpc, RpcError } from "../src/rpc.ts";
import { baseLogsLine } from "../src/send.ts";
import { type Answer, COLDKEY, fakeChain, v3Record } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

/** What mainnet.base.org answers an eth_getLogs (verified live, 2026-10-28). */
const LIMITED = () => {
  throw new RpcError("base eth_getLogs: request limit reached", -32011);
};
const BASE_HEAD = 20_000_000;

/** The logs server's head block time; its blocks are 2 seconds apart. */
const HEAD_TIME = 1_800_000_000;

/** A logs server: Base's head at `head` (its blocks' times 2 seconds apart, the head's HEAD_TIME), and
 * `logs` (filtered by block range); every request is kept. */
function logsServer(head: number, logs: { blockNumber: Hex; topics: Hex[]; address: Address; data: Hex; logIndex: Hex; transactionHash: Hex }[] = [], fail?: () => never) {
  const asked: { chain: ChainName; method: string }[] = [];
  const rpc: Rpc = {
    async request(chain, method, params) {
      asked.push({ chain, method });
      if (method === "eth_chainId") return numberToHex(chain === "base" ? 8453 : 964);
      if (method === "eth_blockNumber") return numberToHex(head);
      if (method === "eth_getBlockByNumber") return { timestamp: numberToHex(HEAD_TIME + 2 * (Number(params[0]) - head)) };
      if (method === "eth_getLogs") {
        if (fail) fail();
        const q = params[0] as { fromBlock: Hex; toBlock: Hex };
        return logs.filter((l) => BigInt(l.blockNumber) >= BigInt(q.fromBlock) && BigInt(l.blockNumber) <= BigInt(q.toBlock));
      }
      throw new Error(`the logs server was asked ${method}`);
    },
  };
  return { rpc, asked };
}

describe("Base's log scans have their own RPC", () => {
  it("OPS_BASE_LOGS_RPC, else OPS_BASE_RPC unless it is mainnet.base.org (which refuses eth_getLogs), else publicnode", () => {
    expect(baseLogsTarget({})).toEqual({ name: "base", rpcUrl: "https://base-rpc.publicnode.com", chainId: 8453, legacy: false });
    const keyed = "https://lb.drpc.org/ogrpc?network=base&dkey=SECRETKEY";
    expect(baseLogsTarget({ OPS_BASE_RPC: keyed }).rpcUrl).toBe(keyed);
    expect(baseLogsTarget({ OPS_BASE_RPC: "https://mainnet.base.org" }).rpcUrl).toBe("https://base-rpc.publicnode.com");
    expect(baseLogsTarget({ OPS_BASE_RPC: "https://mainnet.base.org/" }).rpcUrl).toBe("https://base-rpc.publicnode.com");
    expect(baseLogsTarget({ OPS_BASE_RPC: keyed, OPS_BASE_LOGS_RPC: "https://logs.example" }).rpcUrl).toBe("https://logs.example");
  });

  it("says which host it reads Base's logs from, its origin only, once and only when Base's logs are read", async () => {
    const line = baseLogsLine(baseLogsTarget({ OPS_BASE_RPC: "https://lb.drpc.org/ogrpc?network=base&dkey=SECRETKEY" }));
    expect(line).toBe("Reading Base's logs from drpc.org (set OPS_BASE_LOGS_RPC to change it)");
    expect(line).not.toContain("SECRET");
    // the registrable domain only: a key in a subdomain is never printed
    const domainOf = (url: string) => baseLogsLine({ ...baseLogsTarget({}), rpcUrl: url });
    expect(domainOf("https://SECRETKEY.base-mainnet.quiknode.pro/x")).toBe("Reading Base's logs from quiknode.pro (set OPS_BASE_LOGS_RPC to change it)");
    expect(domainOf("https://base-rpc.publicnode.com")).toContain(" from publicnode.com ");
    expect(domainOf("https://lb.drpc.live/base/SECRETKEY")).toContain(" from drpc.live ");
    expect(domainOf("http://127.0.0.1:8545")).toContain(" from 127.0.0.1 ");
    expect(domainOf("not a url")).toContain(" from an RPC that isn't a URL ");
    const said: string[] = [];
    const logs = logsRpc(logsServer(1_000).rpc, logsServer(BASE_HEAD).rpc, { announce: () => said.push("base logs") });
    await logs.request("bittensor", "eth_blockNumber", []);
    expect(said).toEqual([]);
    await logs.request("base", "eth_blockNumber", []);
    await logs.request("base", "eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]);
    expect(said).toEqual(["base logs"]);
  });

  it("asks it for 10,000 blocks a query (OPS_BASE_LOGS_WINDOW): the 100-block window was mainnet.base.org's", async () => {
    expect(baseLogsWindow({})).toBe(10_000n);
    expect(baseLogsWindow({ OPS_BASE_LOGS_WINDOW: " 2000 " })).toBe(2_000n);
    for (const bad of ["0", "-5", "1e4", "lots"]) expect(() => baseLogsWindow({ OPS_BASE_LOGS_WINDOW: bad }), bad).toThrow(/OPS_BASE_LOGS_WINDOW/);
    const base = logsServer(BASE_HEAD);
    const ev = parseAbi(["event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer)"])[0];
    await scanLogs({ ...fakeChain([], {}).ctx, logs: base.rpc, logsWindow: { base: 10_000n } }, "base", BASE_V3.USDC, ev, BigInt(BASE_HEAD - 7_200));
    expect(base.asked.filter((a) => a.method === "eth_getLogs")).toHaveLength(1);
  });

  it("routes Base to the logs server and Bittensor to the main RPC, after checking the logs server is Base", async () => {
    const main = logsServer(1_000);
    const base = logsServer(BASE_HEAD);
    const logs = logsRpc(main.rpc, base.rpc);
    expect(await logs.request("base", "eth_blockNumber", [])).toBe(numberToHex(BASE_HEAD));
    expect(await logs.request("bittensor", "eth_blockNumber", [])).toBe(numberToHex(1_000));
    await logs.request("base", "eth_blockNumber", []);
    expect(base.asked.map((a) => a.method)).toEqual(["eth_chainId", "eth_blockNumber", "eth_blockNumber"]);
    expect(main.asked.map((a) => `${a.chain} ${a.method}`)).toEqual(["bittensor eth_blockNumber"]);
  });

  it("refuses a logs server on another chain, whose silence would read as no logs", async () => {
    const wrong: Rpc = { request: async (_c, m) => (m === "eth_chainId" ? numberToHex(1) : numberToHex(5)) };
    await expect(logsRpc(logsServer(1).rpc, wrong).request("base", "eth_getLogs", [{}])).rejects.toThrow(
      "OPS_BASE_LOGS_RPC answers chain id 1, not Base (8453): set it to a Base RPC that serves eth_getLogs",
    );
  });

  it("scanLogs takes the head and the logs from the logs server, never the main RPC", async () => {
    const main = fakeChain([], {}, { eth_getLogs: LIMITED, eth_blockNumber: () => numberToHex(BASE_HEAD - 500) });
    const base = logsServer(BASE_HEAD);
    const ev = parseAbi(["event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer)"])[0];
    await scanLogs({ ...main.ctx, logs: base.rpc }, "base", BASE_V3.USDC, ev, BigInt(BASE_HEAD - 150));
    expect(main.calls).toEqual([]);
    expect(base.asked.map((a) => a.method)).toEqual(["eth_blockNumber", "eth_getLogs", "eth_getLogs"]);
  });

  it("the registry scan and preflight's probe use it too", async () => {
    const plan = buildPlanV3(4, 9, COLDKEY);
    const rec = v3Record("live", plan);
    const main = fakeChain([], {}, { eth_getLogs: (c) => (c === "base" ? LIMITED() : []), eth_blockNumber: () => numberToHex(5) });
    const base = logsServer(50);
    await scanRegistry({ ...main.ctx, logs: logsRpc(main.ctx.rpc, base.rpc) }, rec, { base: { to: 10, bridges: [], routes: [] }, bittensor: { to: 4, bridges: [], frontDoors: [] } });
    expect(main.calls.filter((c) => c.chain === "base")).toEqual([]);
    expect(base.asked.filter((a) => a.method === "eth_getLogs")).toHaveLength(1);
    expect(await logProbe({ ...main.ctx, logs: logsServer(BASE_HEAD).rpc }, "base")).toBeNull();
    // without it, the probe meets mainnet.base.org's refusal
    expect(await logProbe(main.ctx, "base")).toMatch(/request limit reached/);
  });
});

describe("the keeper's close economics read the batch's deposits from the logs server", () => {
  const T = 1_800_000_000;
  const STAKER_AT: Address = getAddress("0x00000000000000000000000000000000000000a2");
  const ORACLE_AT: Address = getAddress("0x00000000000000000000000000000000000000a1");
  const alice: Address = "0x000000000000000000000000000000000000a11c";
  const launch = v3Record("live", buildPlanV3(0, 0, COLDKEY, "launch", ROLES));
  const DEPOSIT_REQUESTED = parseAbi(["event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer)"]);
  const staked = {
    address: launch.plan.addresses.frontDoor,
    topics: encodeEventTopics({ abi: DEPOSIT_REQUESTED, eventName: "DepositRequested", args: { batchId: 7n, user: alice } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters("uint256, address"), [4n * 10n ** 17n, STAKER_AT]),
    blockNumber: numberToHex(BASE_HEAD - 50),
    logIndex: "0x0" as Hex,
    transactionHash: numberToHex(1, { size: 32 }),
  };
  const answers: Record<string, Answer> = {
    openDeposits: () => [{ user: alice, amount: 4n * 10n ** 17n }],
    openRedeems: () => [],
    canClose: () => true,
    paused: () => false,
    claimable: () => 0n,
    depositCap: () => 10n ** 21n,
    openBatch: () => [7n, BigInt(T - 7_200), 4n * 10n ** 17n, 10n ** 14n, 1n, 0n],
    batchInterval: () => 3_600n,
    maxDeposits: () => 100,
    maxRedeems: () => 100,
    maxBatchValue: () => 4_000n * 10n ** 18n,
    minDeposit: () => 10n ** 16n,
    oracle: () => ORACLE_AT,
    swapper: () => STAKER_AT,
    usdcValue: ([wei]) => ((wei as bigint) * 250_000_000n) / 10n ** 18n,
    depositFeeUsdc: () => 50_000n,
    swapFeeBps: () => 15,
    quoteExactInput: ([, amount]) => [((amount as bigint) * 2_300_000_000n) / 10n ** 18n, [], [], 0n],
    quoteFee: () => 6n * 10n ** 14n,
    isPaused: () => false,
    migrationReadyAt: () => 0n,
    migrationFinished: () => false,
    pendingPayouts: () => 0n,
    payoutDelay: () => 86_400n,
    rootStakeRao: () => 0n,
    minStakeRao: () => 0n,
    getNominatorMinRequiredStake: () => 0n,
    totalAssets: () => 0n,
  };
  /** Base's main RPC refuses eth_getLogs, as mainnet.base.org does; the logs server is `logs`. */
  const world = (logs: Rpc) => {
    const lines: string[] = [];
    const main = fakeChain(Object.values(KEEPER_READ_ABIS), answers, {
      eth_getBalance: () => "0x0",
      eth_blockNumber: (c) => numberToHex(c === "base" ? BASE_HEAD : 1_000),
      eth_getLogs: (c) => (c === "base" ? LIMITED() : []),
    });
    const ctx = { ...main.ctx, logs: logsRpc(main.ctx.rpc, logs), log: (l: string) => void lines.push(l) };
    return { deps: keeperDeps(ctx, launch, join(mkdtempSync(join(tmpdir(), "ops-logs-")), "rec.json")), lines };
  };

  it("with a logs server that answers, the fee rule has its numbers although mainnet.base.org refuses", async () => {
    const w = world(logsServer(BASE_HEAD, [staked]).rpc);
    expect((await w.deps.readState({ economics: true })).frontDoor.closeEconomics).toEqual({ feesUsdc: 50_000n + 150_000n + 230_000n, bridgeFeeUsdc: 1_380_000n });
    expect(w.lines).toEqual([]);
  });

  it("when the logs server fails too, the batch waits its max wait, and says so once with the variable to set", async () => {
    const w = world(logsServer(BASE_HEAD, [], LIMITED).rpc);
    expect((await w.deps.readState({ economics: true })).frontDoor.closeEconomics).toBeNull();
    expect((await w.deps.readState({ economics: true })).frontDoor.closeEconomics).toBeNull();
    expect(w.lines).toEqual([
      "Base logs: couldn't read batch 7's deposits (base eth_getLogs: request limit reached), so its deposit fees are unknown and it waits for its max wait (24 hours) instead of closing when they cover its bridge fee. Set OPS_BASE_LOGS_RPC to a Base RPC that serves eth_getLogs (without it, OPS_BASE_RPC unless that is mainnet.base.org, else https://base-rpc.publicnode.com).",
    ]);
  });
});
