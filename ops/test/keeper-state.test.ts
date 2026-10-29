import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AbiFunction,
  type AbiParameter,
  type Address,
  encodeFunctionResult,
  encodePacked,
  getAddress,
  type Hex,
  hexToBigInt,
  numberToHex,
  toFunctionSelector,
} from "viem";
import { describe, expect, it } from "vitest";
import { BASE_V3, type ChainName, paths, targets, WALLET } from "../src/config.ts";
import { roll } from "../src/keeper/actions.ts";
import { KEEPER_READ_ABIS, keeperDeps, scanLogs } from "../src/keeper/state.ts";
import { buildPlan, buildPlanV3, closeMaxWaitS } from "../src/plan.ts";
import { type DeploymentRecord, loadRecord, saveRecord } from "../src/record.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { type Ctx, ReceiptTimeout, RevertedOnChain, SendRefused } from "../src/send.ts";
import { type Answer, COLDKEY, fakeChain, revert, v3Record } from "./fake-keeper.ts";

const ZERO32: Hex = `0x${"00".repeat(32)}`;
const MSG: Hex = `0x${"5a".repeat(32)}`;

function defaultFor(p: AbiParameter): unknown {
  if (p.type.endsWith("]")) return [];
  if (p.type === "tuple") {
    return Object.fromEntries((p as { components: readonly AbiParameter[] }).components.map((c) => [c.name, defaultFor(c)]));
  }
  if (p.type === "bool") return false;
  if (p.type === "address") return "0x0000000000000000000000000000000000000000";
  if (p.type.startsWith("bytes")) return ZERO32;
  if (p.type === "string") return "";
  return 0n;
}

/** Answers every view the keeper reads with zero values; getExecutionState answers SUCCESS. */
function fakeChains(onLogs: (chain: ChainName, from: bigint, to: bigint) => unknown[] = () => []) {
  const fns = (Object.values(KEEPER_READ_ABIS).flat() as unknown as AbiFunction[]).filter((i) => i.type === "function");
  const calls: { chain: ChainName; method: string }[] = [];
  const rpc: Rpc = {
    async request(chain, method, params) {
      calls.push({ chain, method });
      switch (method) {
        case "eth_call": {
          const data = (params[0] as { data: Hex }).data;
          const fn = fns.find((f) => toFunctionSelector(f) === data.slice(0, 10));
          if (!fn) throw new Error(`unexpected call ${data.slice(0, 10)}`);
          const result = fn.name === "getExecutionState" ? 2 : fn.outputs.length === 1 ? defaultFor(fn.outputs[0]) : fn.outputs.map(defaultFor);
          return encodeFunctionResult({ abi: [fn], functionName: fn.name, result } as never);
        }
        case "eth_getBalance":
          return "0x0";
        case "eth_blockNumber":
          return numberToHex(1_000);
        case "eth_getBlockByNumber":
          return { timestamp: "0x1" };
        case "eth_getLogs": {
          const q = params[0] as { fromBlock: Hex; toBlock: Hex };
          return onLogs(chain, hexToBigInt(q.fromBlock), hexToBigInt(q.toBlock));
        }
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const ctx: Ctx = { live: true, targets: targets({}).live, rpc, runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) }, paths: paths({}), log: () => undefined, receiptTimeoutMs: 10 };
  return { ctx, calls };
}

const plan = buildPlan(0, 0, ZERO32);
const sent = { hash: ZERO32, block: 10, gasUsed: 1n, costWei: 1n };
const rec: DeploymentRecord = {
  target: "live",
  wallet: WALLET,
  createdAt: "",
  plan,
  done: Object.fromEntries(plan.steps.map((s) => [s.id, sent])),
  messages: [{ id: MSG, direction: "Base → Bittensor", hash: ZERO32, at: "" }],
};

describe("keeper reads", () => {
  it("scans Base in windows the public RPC accepts (it refuses more than 200 blocks)", async () => {
    const f = fakeChains((chain, from, to) => {
      if (chain === "base" && to - from + 1n > 200n) throw new Error("eth_getLogs is limited to a 200 range");
      return [];
    });
    const ev = KEEPER_READ_ABIS.FRONT.find((i) => (i as { name?: string }).name === "BatchClosed") as never;
    await expect(scanLogs(f.ctx, "base", plan.addresses.frontDoor, ev, 0n)).resolves.toEqual([]);
  });

  it("reads the state with no Base log scan, taking bridge messages from the record", async () => {
    const f = fakeChains((chain) => {
      if (chain === "base") throw new Error("eth_getLogs is limited to a 200 range");
      return [];
    });
    const recordPath = join(mkdtempSync(join(tmpdir(), "ops-state-")), "rec.json");
    const s = await keeperDeps(f.ctx, rec, recordPath).readState();
    expect(f.calls.some((c) => c.chain === "base" && c.method === "eth_getLogs")).toBe(false);
    expect(s.detail.messages).toEqual([{ id: MSG, direction: "Base → Bittensor", state: "SUCCESS" }]);
  });

  it("adds a bridge message to the record as it is on disk now, never writing back the copy the command loaded", async () => {
    const recordPath = join(mkdtempSync(join(tmpdir(), "ops-state-")), "rec.json");
    saveRecord(recordPath, { ...rec, verify: { ok: true, failures: [], checkedAt: "" } });
    const loaded = loadRecord(recordPath)!;
    const deps = keeperDeps(fakeChains().ctx, loaded, recordPath);
    // while this command runs, a failed verify and a hand-run close save to the same record
    const OTHER: Hex = `0x${"0d".repeat(32)}`;
    const NEW: Hex = `0x${"0e".repeat(32)}`;
    const failed = { ok: false, failures: ["Base CascadeFrontDoor.owner: expected …"], checkedAt: "later" };
    saveRecord(recordPath, { ...loadRecord(recordPath)!, verify: failed, messages: [...(rec.messages ?? []), { id: OTHER, direction: "Base → Bittensor", hash: ZERO32, at: "" }] });
    deps.recordMessage({ id: NEW, direction: "Bittensor → Base", hash: ZERO32 });
    const after = loadRecord(recordPath)!;
    expect(after.verify).toEqual(failed);
    expect(after.messages?.map((m) => m.id)).toEqual([MSG, OTHER, NEW]);
    // and the command's own copy lists the messages too, for its status
    expect(loaded.messages?.map((m) => m.id)).toEqual([MSG, OTHER, NEW]);
  });
});

describe("the open batch and its close's economics", () => {
  const T = 1_800_000_000; // the fake chain's block time
  const HOUR = 3600;
  const ORACLE_AT: Address = getAddress("0x00000000000000000000000000000000000000a1");
  const STAKER_AT: Address = getAddress("0x00000000000000000000000000000000000000a2");
  const alice: Address = "0x000000000000000000000000000000000000a11c";
  const ETH_USDC = encodePacked(["address", "uint24", "address"], [BASE_V3.WETH, 500, BASE_V3.USDC]).toLowerCase();
  const launch: DeploymentRecord = { ...v3Record(), plan: buildPlanV3(0, 0, COLDKEY, "launch") };
  const PRICE_READS = ["oracle", "swapper", "usdcValue", "depositFeeUsdc", "swapFeeBps", "quoteExactInput", "quoteFee"];

  /** A launch batch two hours old, the contract able to close it: one deposit of 0.4 TAO, a 0.0001 ETH
   * fee pot; TAO at $250, ETH at $2,300, a 15 bps swap fee, a $0.05 deposit fee, a 0.0006 ETH bridge fee. */
  function chain(over: Record<string, Answer> = {}, methods: Record<string, (chain: ChainName, params: unknown[]) => unknown> = {}) {
    const answers: Record<string, Answer> = {
      openDeposits: () => [{ user: alice, amount: 4n * 10n ** 17n }],
      openRedeems: () => [],
      canClose: () => true,
      paused: () => false,
      claimable: () => 0n,
      depositCap: () => 10n ** 21n,
      openBatch: () => [7n, BigInt(T - 2 * HOUR), 4n * 10n ** 17n, 10n ** 14n, 1n, 0n],
      batchInterval: () => BigInt(HOUR),
      maxDeposits: () => 100,
      maxRedeems: () => 100,
      maxBatchValue: () => 4_000n * 10n ** 18n,
      minDeposit: () => 10n ** 16n,
      oracle: () => ORACLE_AT,
      swapper: () => STAKER_AT,
      usdcValue: ([wei]) => ((wei as bigint) * 250_000_000n) / 10n ** 18n,
      depositFeeUsdc: () => 50_000n,
      swapFeeBps: () => 15,
      quoteExactInput: ([path, amount]) => {
        if ((path as Hex).toLowerCase() !== ETH_USDC) throw new Error(`quoted an unexpected path ${path}`);
        return [((amount as bigint) * 2_300_000_000n) / 10n ** 18n, [], [], 0n];
      },
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
      ...over,
    };
    return fakeChain(Object.values(KEEPER_READ_ABIS), answers, {
      eth_getBalance: () => "0x0",
      eth_blockNumber: () => numberToHex(1_000),
      eth_getLogs: () => [],
      ...methods,
    });
  }
  const LIMIT_READS = ["maxDeposits", "maxRedeems", "maxBatchValue", "minDeposit"];
  const recordPath = () => join(mkdtempSync(join(tmpdir(), "ops-state-")), "rec.json");
  const read = (f: ReturnType<typeof chain>, r: DeploymentRecord = launch) => keeperDeps(f.ctx, r, recordPath()).readState();
  const called = (f: ReturnType<typeof chain>) => f.calls.map((c) => c.fn).filter((n) => n !== undefined);

  it("estimates the batch's fees and the bridge fee in USDC units from the chain's reads", async () => {
    const f = chain();
    const s = await read(f);
    expect(s.frontDoor).toMatchObject({ canClose: true, nDeposits: 1, nRedeems: 0, openStart: T - 2 * HOUR, batchInterval: HOUR, full: false });
    expect(s.closeMaxWaitS).toBe(86_400);
    // 1 × $0.05 + 0.4 TAO × $250 × 15 bps + 0.0001 ETH × $2,300; the bridge fee 0.0006 ETH × $2,300
    expect(s.frontDoor.closeEconomics).toEqual({ feesUsdc: 50_000n + 150_000n + 230_000n, bridgeFeeUsdc: 1_380_000n });
    // the front door's own oracle and staker
    expect(f.calls.find((c) => c.fn === "usdcValue")).toMatchObject({ to: ORACLE_AT, args: [10n ** 18n] });
    expect(f.calls.find((c) => c.fn === "depositFeeUsdc")?.to).toBe(STAKER_AT);
    expect(f.calls.find((c) => c.fn === "swapFeeBps")?.to).toBe(STAKER_AT);
  });

  it("a failed price or fee read leaves the economics unknown (null), never a guess", async () => {
    expect((await read(chain({ usdcValue: () => { throw revert("OLD"); } }))).frontDoor.closeEconomics).toBeNull();
    const noAnswer = () => {
      throw new RpcError("base eth_call: header not found", -32000);
    };
    expect((await read(chain({ quoteExactInput: noAnswer }))).frontDoor.closeEconomics).toBeNull();
    expect((await read(chain({ depositFeeUsdc: noAnswer }))).frontDoor.closeEconomics).toBeNull();
    expect((await read(chain({ quoteFee: () => { throw revert("fee"); } }))).frontDoor.closeEconomics).toBeNull();
  });

  it("a zero ETH price, TAO price or bridge fee is not a price: the economics are unknown (null), never 'covered'", async () => {
    // a zero ETH price or bridge fee would make the bridge fee $0, so any batch would count as covered
    expect((await read(chain({ quoteExactInput: () => [0n, [], [], 0n] }))).frontDoor.closeEconomics).toBeNull();
    expect((await read(chain({ quoteFee: () => 0n }))).frontDoor.closeEconomics).toBeNull();
    expect((await read(chain({ usdcValue: () => 0n }))).frontDoor.closeEconomics).toBeNull();
    // a zero fee setting is still a reading: it only lowers the estimate
    expect((await read(chain({ depositFeeUsdc: () => 0n, swapFeeBps: () => 0 }))).frontDoor.closeEconomics).toEqual({ feesUsdc: 230_000n, bridgeFeeUsdc: 1_380_000n });
  });

  it("reads no prices when the fees can't change the decision", async () => {
    // test cadence: the record's max wait (none), so a young batch closes as soon as it can
    const test = chain({ batchInterval: () => 60n, openBatch: () => [7n, BigInt(T - 61), 4n * 10n ** 17n, 10n ** 14n, 1n, 0n] });
    const ts = await read(test, v3Record());
    expect(ts.closeMaxWaitS).toBe(closeMaxWaitS(v3Record().plan));
    expect(ts.frontDoor.closeEconomics).toBeUndefined();
    // launch, but 24 hours old; or not yet closable; or empty
    const old = chain({ openBatch: () => [7n, BigInt(T - 86_400), 4n * 10n ** 17n, 10n ** 14n, 1n, 0n] });
    const notYet = chain({ canClose: () => false });
    const empty = chain({ openDeposits: () => [], openBatch: () => [7n, BigInt(T - 2 * HOUR), 0n, 0n, 0n, 0n] });
    for (const f of [test, old, notYet, empty]) {
      if (f !== test) expect((await read(f)).frontDoor.closeEconomics).toBeUndefined();
      expect(called(f).filter((n) => PRICE_READS.includes(n))).toEqual([]);
    }
    // nor the limits when they can't change it: the test cadence reads only openBatch and batchInterval
    for (const f of [test, old]) expect(called(f).filter((n) => LIMIT_READS.includes(n))).toEqual([]);
  });

  it("ages the batch on Base's clock (openStart is a Base time); Bittensor's stays the keeper's `now`", async () => {
    // 24 hours old on Base, 23 on Bittensor's trailing clock: past the max wait, so no prices are read
    const blocks = { eth_getBlockByNumber: (c: ChainName) => ({ timestamp: numberToHex(c === "base" ? T : T - HOUR) }) };
    const f = chain({ openBatch: () => [7n, BigInt(T - 86_400), 4n * 10n ** 17n, 10n ** 14n, 1n, 0n] }, blocks);
    const s = await read(f);
    expect([s.now, s.frontDoor.now]).toEqual([T - HOUR, T]);
    expect(called(f).filter((n) => PRICE_READS.includes(n) || LIMIT_READS.includes(n))).toEqual([]);
    // and the other way round: 23 hours on Base, 24 on Bittensor, so the fees still decide
    const behind = { eth_getBlockByNumber: (c: ChainName) => ({ timestamp: numberToHex(c === "base" ? T - HOUR : T) }) };
    expect((await read(chain({ openBatch: () => [7n, BigInt(T - 86_400), 4n * 10n ** 17n, 10n ** 14n, 1n, 0n] }, behind))).frontDoor.closeEconomics).not.toBeUndefined();
  });

  it("a batch at a list or value limit is full, before or after its interval, and needs no prices", async () => {
    const atList = chain({ maxDeposits: () => 1 });
    expect((await read(atList)).frontDoor.full).toBe(true);
    expect(called(atList).filter((n) => PRICE_READS.includes(n))).toEqual([]);
    expect((await read(chain({ maxBatchValue: () => 4n * 10n ** 17n }))).frontDoor.full).toBe(true);
    expect((await read(chain({ maxBatchValue: () => 4n * 10n ** 17n + 10n ** 16n - 1n }))).frontDoor.full).toBe(true);
    const young = chain({ maxRedeems: () => 0, openBatch: () => [7n, BigInt(T - 60), 4n * 10n ** 17n, 10n ** 14n, 1n, 0n] });
    expect((await read(young)).frontDoor.full).toBe(true);
  });
});

describe("a roll goes through the same send guards as close", () => {
  const T = 1_800_000_000;
  const launch: DeploymentRecord = { ...v3Record(), plan: buildPlanV3(0, 0, COLDKEY, "launch") };
  const recordPath = () => join(mkdtempSync(join(tmpdir(), "ops-roll-")), "rec.json");

  /** An empty launch batch two hours old that the front door would let close; the wallet's next nonce
   * is 4. `chain` overrides the node's answers. */
  function chain(methods: Record<string, (chain: ChainName, params: unknown[]) => unknown> = {}, answers: Record<string, Answer> = {}) {
    const estimates: unknown[] = [];
    const zero = () => 0n;
    const f = fakeChain(
      Object.values(KEEPER_READ_ABIS),
      {
        maxDeposits: () => 100,
        maxRedeems: () => 100,
        maxBatchValue: () => 4_000n * 10n ** 18n,
        minDeposit: () => 10n ** 16n,
        openDeposits: () => [],
        openRedeems: () => [],
        canClose: () => true,
        paused: () => false,
        claimable: zero,
        depositCap: zero,
        openBatch: () => [7n, BigInt(T - 7200), 0n, 0n, 0n, 0n],
        batchInterval: () => 3600n,
        isPaused: () => false,
        migrationReadyAt: zero,
        migrationFinished: () => false,
        pendingPayouts: zero,
        payoutDelay: () => 86_400n,
        rootStakeRao: zero,
        minStakeRao: zero,
        getNominatorMinRequiredStake: zero,
        totalAssets: zero,
        ...answers,
      },
      {
        eth_getBalance: () => "0x0",
        eth_blockNumber: () => numberToHex(1_000),
        eth_getLogs: () => [],
        eth_chainId: (c) => numberToHex(f.ctx.targets[c].chainId),
        eth_getTransactionCount: () => numberToHex(4),
        eth_estimateGas: (_c, params) => {
          estimates.push(params[0]);
          throw revert("InsufficientFee");
        },
        ...methods,
      },
    );
    return { ...f, estimates };
  }

  it("refuses without --live, on the wrong chain, and behind a pending transaction, before any estimate", async () => {
    const f = chain();
    await expect(roll(keeperDeps({ ...f.ctx, live: false }, launch, recordPath()), launch)).rejects.toThrow(SendRefused);
    await expect(roll(keeperDeps({ ...f.ctx, live: false }, launch, recordPath()), launch)).rejects.toThrow(/--live/);
    await expect(roll(keeperDeps(chain({ eth_chainId: () => "0x1" }).ctx, launch, recordPath()), launch)).rejects.toThrow(/chain id 1/);
    const pending = chain({ eth_getTransactionCount: (_c, p) => numberToHex(p[1] === "pending" ? 5 : 4) });
    await expect(roll(keeperDeps(pending.ctx, launch, recordPath()), launch)).rejects.toThrow(/still waiting to be mined/);
    expect([...f.estimates, ...pending.estimates]).toEqual([]);
  });

  it("is simulated with no value before anything is signed; a refusal is a skip", async () => {
    const f = chain();
    const r = await roll(keeperDeps(f.ctx, launch, recordPath()), launch);
    expect(r).toMatchObject({ rolled: false, reason: expect.stringMatching(/would fail/) });
    expect(f.estimates).toEqual([{ from: WALLET, to: launch.plan.addresses.frontDoor, data: toFunctionSelector("closeBatch()"), value: "0x0" }]);
  });
});

describe("a roll that reverts on chain", () => {
  const T = 1_800_000_000;
  const HASH: Hex = `0x${"7e".repeat(32)}`;
  const alice: Address = "0x000000000000000000000000000000000000a11c";
  const launch: DeploymentRecord = { ...v3Record(), plan: buildPlanV3(0, 0, COLDKEY, "launch") };
  const recordPath = () => join(mkdtempSync(join(tmpdir(), "ops-roll-")), "rec.json");

  /** An empty launch batch two hours old that the front door would let close. The roll passes every
   * guard and its simulation, is signed and sent, then its receipt says it reverted (`receipt` null:
   * none comes). Once it is sent, the front door answers with `after`. */
  function racing(after: Record<string, Answer>, receipt: unknown = { status: "0x0", blockNumber: "0x10", gasUsed: "0x8000", effectiveGasPrice: "0x1", contractAddress: null, logs: [] }) {
    let sent = false;
    const zero = () => 0n;
    const before: Record<string, Answer> = {
      maxDeposits: () => 100,
      maxRedeems: () => 100,
      maxBatchValue: () => 4_000n * 10n ** 18n,
      minDeposit: () => 10n ** 16n,
      openDeposits: () => [],
      openRedeems: () => [],
      canClose: () => true,
      paused: () => false,
      claimable: zero,
      depositCap: zero,
      openBatch: () => [7n, BigInt(T - 7200), 0n, 0n, 0n, 0n],
      batchInterval: () => 3600n,
      isPaused: () => false,
      migrationReadyAt: zero,
      migrationFinished: () => false,
      pendingPayouts: zero,
      payoutDelay: () => 86_400n,
      rootStakeRao: zero,
      minStakeRao: zero,
      getNominatorMinRequiredStake: zero,
      totalAssets: zero,
    };
    const answers = Object.fromEntries(
      Object.keys({ ...before, ...after }).map((name) => [name, ((args, call) => (sent && after[name] ? after[name] : before[name])(args, call)) as Answer]),
    );
    const f = fakeChain(Object.values(KEEPER_READ_ABIS), answers, {
      eth_getBalance: () => "0x0",
      eth_blockNumber: () => numberToHex(1_000),
      eth_getLogs: () => [],
      eth_chainId: (c) => numberToHex(f.ctx.targets[c].chainId),
      eth_getTransactionCount: () => numberToHex(4),
      eth_estimateGas: () => "0x88b8",
      eth_gasPrice: () => "0x1",
      eth_getTransactionReceipt: () => receipt,
    });
    const ctx: Ctx = {
      ...f.ctx,
      pollMs: 1,
      runner: {
        run: async (_file, args) => {
          if (args[0] === "wallet") return { code: 0, stdout: WALLET, stderr: "" };
          sent = true;
          return { code: 0, stdout: `transactionHash ${HASH}`, stderr: "" };
        },
      },
    };
    return keeperDeps(ctx, launch, recordPath());
  }
  const reason = `an entry or another close landed first; the roll reverted (transaction ${HASH})`;

  it("is a skip when a deposit landed first", async () => {
    const deposited = racing({ openDeposits: () => [{ user: alice, amount: 10n ** 16n }], openBatch: () => [7n, BigInt(T - 7200), 10n ** 16n, 0n, 1n, 0n] });
    expect(await roll(deposited, launch)).toEqual({ rolled: false, reason });
  });

  it("is a skip when a redeem landed first", async () => {
    expect(await roll(racing({ openRedeems: () => [{ user: alice, amount: 10n ** 22n }] }), launch)).toEqual({ rolled: false, reason });
  });

  it("is a skip when another roll or close landed first", async () => {
    expect(await roll(racing({ canClose: () => false, openBatch: () => [8n, BigInt(T), 0n, 0n, 0n, 0n] }), launch)).toEqual({ rolled: false, reason });
  });

  it("stops the keeper when the batch is still empty and could close: that revert is unexplained", async () => {
    await expect(roll(racing({}), launch)).rejects.toThrow(RevertedOnChain);
  });

  it("a roll with no receipt still stops the keeper", async () => {
    await expect(roll(racing({ openDeposits: () => [{ user: alice, amount: 10n ** 16n }] }, null), launch)).rejects.toThrow(ReceiptTimeout);
  });
});
