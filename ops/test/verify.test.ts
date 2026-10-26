import { type Address, decodeFunctionData, encodeEventTopics, encodeFunctionResult, type Hex, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { loadArtifact } from "../src/artifacts.ts";
import { paths, WALLET } from "../src/config.ts";
import { buildPlan, buildPlanV3 } from "../src/plan.ts";
import {
  activationLogs,
  codeMismatch,
  compare,
  type Expectation,
  expectations,
  frontDoorActivationFailures,
  keyOf,
  readBack,
  reserveFailures,
  treasuryCodeFailures,
  v3AddressFailures,
} from "../src/verify.ts";

const plan = buildPlan(0, 0, `0x${"33".repeat(32)}`);
const plan3 = buildPlanV3(0, 40, `0x${"33".repeat(32)}`);
const OTHER: Address = "0x0000000000000000000000000000000000000001";

/** A value of the same type that differs from `v`. */
const wrong = (v: unknown): unknown =>
  typeof v === "bigint" ? v + 1n : typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : v === OTHER ? WALLET : OTHER;

describe("verify v3", () => {
  const exp3 = expectations(plan3);
  const v2Keys = new Set(expectations(plan).map(keyOf));
  const added = exp3.filter((e) => !v2Keys.has(keyOf(e)));
  const expected = (contract: string, field: string) => exp3.find((e) => e.contract === contract && e.field === field)?.expected;

  it("reads back every v3 setting: front door, staker, oracle and the vault's reward cut", () => {
    expect(added.map((e) => `${e.contract}.${e.field}`)).toEqual([
      "CascadeFrontDoor.usdc",
      "CascadeFrontDoor.keeper",
      "CascadeFrontDoor.swapper",
      "CascadeFrontDoor.oracle",
      "CascadeFrontDoor.maxDeliverySlippageBps",
      "CascadeFrontDoor.maxBatchValue",
      "CascadeStaker.usdc",
      "CascadeStaker.tao",
      "CascadeStaker.frontDoor",
      "CascadeStaker.owner",
      "CascadeStaker.treasury",
      "CascadeStaker.swapFeeBps",
      "CascadeStaker.depositFeeUsdc",
      "CascadeStaker.routes(0).kind",
      "CascadeStaker.routes(0).router",
      "CascadeStaker.routes(0).buyPath",
      "CascadeStaker.routes(0).sellPath",
      "CascadeStaker.routes(0).active",
      "CascadeStaker.deliveryRouteId",
      "CascadeTwapOracle.taoWethPool",
      "CascadeTwapOracle.wethUsdcPool",
      "CascadeTwapOracle.tao",
      "CascadeTwapOracle.weth",
      "CascadeTwapOracle.usdc",
      "CascadeVault.treasury",
      "CascadeVault.rewardCutBps",
    ]);
    expect(expected("CascadeFrontDoor", "usdc")).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(expected("CascadeFrontDoor", "swapper")).toBe(plan3.addresses.staker);
    expect(expected("CascadeFrontDoor", "oracle")).toBe(plan3.addresses.oracle);
    expect(expected("CascadeFrontDoor", "maxDeliverySlippageBps")).toBe(150);
    expect(expected("CascadeFrontDoor", "maxBatchValue")).toBe(10n ** 19n);
    expect(expected("CascadeStaker", "frontDoor")).toBe(plan3.addresses.frontDoor);
    expect(expected("CascadeStaker", "treasury")).toBe(WALLET);
    expect([expected("CascadeStaker", "swapFeeBps"), expected("CascadeStaker", "depositFeeUsdc")]).toEqual([15, 50_000n]);
    expect(expected("CascadeStaker", "routes(0).router")).toBe("0x2626664c2603336E57B271c5C0b26F421741e481");
    expect(expected("CascadeStaker", "deliveryRouteId")).toBe(0);
    expect(expected("CascadeTwapOracle", "taoWethPool")).toBe("0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A");
    expect(expected("CascadeTwapOracle", "wethUsdcPool")).toBe("0xd0b53D9277642d899DF5C87A3966A349A798F224");
    expect([expected("CascadeVault", "treasury"), expected("CascadeVault", "rewardCutBps")]).toEqual([WALLET, 1_000]);
  });

  it("checks the v2 fields against the v3 settings", () => {
    expect(expected("CascadeFrontDoor", "minDeposit")).toBe(4n * 10n ** 16n);
    expect(expected("CascadeFrontDoor", "depositCap")).toBe(40n * 10n ** 18n);
    expect(expected("CascadeVault", "stakeHotkey")).toBe("0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748");
    expect(expected("CascadeVault", "payoutDelay")).toBe(3600n);
  });

  it("a read-back that differs in any new field fails with a message naming it", () => {
    const right = new Map(exp3.map((e) => [keyOf(e), e.expected]));
    expect(compare(exp3, right)).toEqual([]);
    for (const e of added) {
      const actual = new Map(right).set(keyOf(e), wrong(e.expected));
      const failures = compare(exp3, actual);
      expect(failures, `${e.contract}.${e.field}`).toHaveLength(1);
      expect(failures[0]).toContain(`${e.contract}.${e.field}: expected`);
    }
  });

  it("compares a number read back with a bigint expectation by value", () => {
    const e: Expectation[] = [{ chain: "base", contract: "CascadeStaker", address: WALLET, field: "swapFeeBps", expected: 15 }];
    expect(compare(e, new Map([[keyOf(e[0]), 15n]]))).toEqual([]);
    expect(compare(e, new Map([[keyOf(e[0]), 16n]]))).toHaveLength(1);
  });

  it("the v2 plan's read-back is unchanged: nothing from v3", () => {
    expect(expectations(plan).some((e) => ["CascadeStaker", "CascadeTwapOracle"].includes(e.contract))).toBe(false);
    expect(expectations(plan).some((e) => e.field === "usdc" || e.field === "treasury" || e.field === "rewardCutBps")).toBe(false);
  });

  it("needs the treasury to be a plain account on Base and on Bittensor", () => {
    expect(treasuryCodeFailures(WALLET, { base: "0x", bittensor: "0x" })).toEqual([]);
    expect(treasuryCodeFailures(WALLET, { base: "0x6080", bittensor: "0x" })).toEqual([
      `Base treasury ${WALLET}: has contract code; the treasury must be a plain account, the same owner on Base and Bittensor`,
    ]);
    expect(treasuryCodeFailures(WALLET, { base: "0x", bittensor: "0x6080" })).toEqual([
      `Bittensor treasury ${WALLET}: has contract code; the treasury must be a plain account, the same owner on Base and Bittensor`,
    ]);
  });

  it("refuses USDC equal to the asset, and a treasury that is the staker, the front door or the vault", () => {
    const right = new Map(exp3.map((e) => [keyOf(e), e.expected]));
    const at = (contract: string, field: string) => keyOf({ chain: contract === "CascadeVault" ? "bittensor" : "base", contract, field });
    expect(v3AddressFailures(plan3, right)).toEqual([]);

    const sameAsAsset = new Map(right).set(at("CascadeFrontDoor", "usdc"), right.get(at("CascadeFrontDoor", "asset")));
    expect(v3AddressFailures(plan3, sameAsAsset)).toEqual([expect.stringMatching(/^Base CascadeFrontDoor\.usdc: .*the same as its asset/)]);

    for (const bad of [plan3.addresses.staker, plan3.addresses.frontDoor]) {
      const m = new Map(right).set(at("CascadeStaker", "treasury"), bad.toLowerCase());
      expect(v3AddressFailures(plan3, m)).toEqual([expect.stringMatching(/^Base CascadeStaker\.treasury: .*not a Cascade contract/)]);
    }
    for (const bad of [plan3.addresses.vault, plan3.addresses.frontDoor, plan3.addresses.staker]) {
      const m = new Map(right).set(at("CascadeVault", "treasury"), bad);
      expect(v3AddressFailures(plan3, m)).toEqual([expect.stringMatching(/^Bittensor CascadeVault\.treasury: .*not a Cascade contract/)]);
    }
  });

  it("reads a route once and picks each of its fields", async () => {
    const abi = loadArtifact(paths({}).contractsDir, "CascadeStaker").abi;
    const route = exp3.filter((e) => e.field.startsWith("routes(0)."));
    const calls: string[] = [];
    const rpc = {
      async request(_c: string, method: string, params: unknown[]) {
        if (method !== "eth_call") throw new Error(method);
        const { functionName, args } = decodeFunctionData({ abi, data: (params[0] as { data: Hex }).data });
        calls.push(`${functionName}(${args?.join(",")})`);
        return encodeFunctionResult({ abi, functionName, result: route.map((e) => e.expected) } as never);
      },
    };
    const actual = await readBack({ rpc } as never, route, () => ({ abi }));
    expect(calls).toEqual(["routes(0)"]);
    expect(compare(route, actual)).toEqual([]);
  });
});

describe("verify", () => {
  const exp = expectations(plan);

  it("expects every immutable and setting the spec lists", () => {
    const fields = new Set(exp.map((e) => `${e.contract}.${e.field}`));
    for (const f of [
      "CcipBaseAdapter.remoteAdapter",
      "CcipBaseAdapter.minSendAmount",
      "CcipBittensorAdapter.alphaVault",
      "CcipBittensorAdapter.gasPerEntry",
      "CascadeFrontDoor.vault",
      "CascadeFrontDoor.primaryBridge",
      "CascadeFrontDoor.depositCap",
      "CascadeVault.stakeHotkey",
      "CascadeVault.keeper",
      "CascadeVault.payoutDelay",
    ]) {
      expect(fields).toContain(f);
    }
    expect(exp.find((e) => e.field === "remoteAdapter" && e.contract === "CcipBaseAdapter")!.expected).toBe(plan.addresses.bitAdapter);
  });

  it("all equal gives no failures; one wrong remoteAdapter names it", () => {
    const actual = new Map(exp.map((e) => [keyOf(e), e.expected]));
    expect(compare(exp, actual)).toEqual([]);
    const wrong = exp.find((e) => e.contract === "CcipBaseAdapter" && e.field === "remoteAdapter") as Expectation;
    actual.set(keyOf(wrong), WALLET);
    expect(compare(exp, actual)).toEqual([
      `Base CcipBaseAdapter.remoteAdapter: expected ${plan.addresses.bitAdapter}, found ${WALLET}`,
    ]);
  });

  it("compares addresses without regard to case", () => {
    const e: Expectation[] = [{ chain: "bittensor", contract: "CascadeVault", address: WALLET, field: "keeper", expected: WALLET }];
    expect(compare(e, new Map([[keyOf(e[0]), WALLET.toLowerCase()]]))).toEqual([]);
  });

  it("needs exactly one FrontDoorActivated(8453, frontDoor) in the vault's creation", () => {
    const abi = parseAbi(["event FrontDoorActivated(uint64 indexed chain, address indexed addr)"]);
    const log = { address: plan.addresses.vault, topics: encodeEventTopics({ abi, args: { chain: 8453n, addr: plan.addresses.frontDoor } }) as Hex[], data: "0x" as Hex };
    expect(frontDoorActivationFailures([log], plan)).toEqual([]);
    expect(frontDoorActivationFailures([log, log], plan)).toHaveLength(1);
    expect(frontDoorActivationFailures([], plan)).toHaveLength(1);
  });

  it("ignores differences inside immutable ranges only", () => {
    const artifact = { deployedBytecode: "0x60aa0000bb" as Hex, immutableRanges: [{ start: 2, length: 2 }] };
    expect(codeMismatch("base", "X", "0x60aa1234bb", artifact)).toBeNull();
    expect(codeMismatch("base", "X", "0x60ab1234bb", artifact)).toMatch(/Base X: deployed code differs/);
  });

  it("checks the reserves net of the existential deposit", () => {
    expect(reserveFailures(499_999_999_999n, 10n ** 12n)).toHaveLength(1);
    expect(reserveFailures(5n * 10n ** 11n, 10n ** 12n)).toEqual([]);
    expect(reserveFailures(5n * 10n ** 11n, 10n ** 12n - 1n)).toHaveLength(1);
  });
});

describe("activationLogs", () => {
  it("finds a recovered vault's FrontDoorActivated in its logs instead of a receipt", async () => {
    const abi = parseAbi(["event FrontDoorActivated(uint64 indexed chain, address indexed addr)"]);
    const topics = encodeEventTopics({ abi, args: { chain: 8453n, addr: plan.addresses.frontDoor } }) as Hex[];
    let served = false;
    const rpc = {
      async request(_c: string, method: string) {
        if (method === "eth_blockNumber") return "0x3e8";
        if (method === "eth_getLogs" && served) return [];
        served = true;
        if (method === "eth_getLogs") return [{ address: plan.addresses.vault, topics, data: "0x", blockNumber: "0x5", logIndex: "0x0", transactionHash: `0x${"11".repeat(32)}` }];
        throw new Error(method);
      },
    };
    const rec = { target: "live" as const, wallet: WALLET, createdAt: "", plan, done: { vault: { recovered: true as const } } };
    const logs = await activationLogs({ rpc } as never, rec);
    expect(frontDoorActivationFailures(logs, plan)).toEqual([]);
  });
});
