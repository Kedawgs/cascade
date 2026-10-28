import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AbiFunction,
  type Address,
  decodeFunctionData,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  numberToHex,
  parseAbi,
  toFunctionSelector,
} from "viem";
import { describe, expect, it } from "vitest";
import { loadArtifact } from "../src/artifacts.ts";
import { type ChainName, paths, WALLET } from "../src/config.ts";
import { buildPlan, buildPlanV3, type PlanV3 } from "../src/plan.ts";
import { type DeploymentRecord, loadRecord, saveRecord } from "../src/record.ts";
import type { Rpc } from "../src/rpc.ts";
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
  verify,
} from "../src/verify.ts";
import { fakeChain } from "./fake-keeper.ts";

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

type Ranges = { start: number; length: number }[];
/** The a2b4412 build's front door and staker, read straight from the checked-in data. */
const A2B4412 = JSON.parse(readFileSync(new URL("../builds/a2b4412.json", import.meta.url), "utf8")) as {
  build: string;
  contracts: Record<string, { deployedBytecode: Hex; immutableReferences: Record<string, Ranges> }>;
};
const CONTRACTS = ["CcipBaseAdapter", "CcipBittensorAdapter", "CascadeVault", "CascadeTwapOracle", "CascadeFrontDoor", "CascadeStaker"];
/** Build output as a chain holds it: real values (here 0xab…) where the build has zeroed immutables. */
const asDeployed = (code: Hex, ranges: Ranges): Hex => {
  const b = code.slice(2).split("");
  for (const { start, length } of ranges) for (let i = start * 2; i < (start + length) * 2; i++) b[i] = i % 2 ? "b" : "a";
  return `0x${b.join("")}`;
};
const contractsDir = paths({}).contractsDir;
/** This build's code for all six contracts, and a2b4412's: its own front door and staker, the rest the same. */
const THIS_CODE: Record<string, Hex> = Object.fromEntries(
  CONTRACTS.map((n) => {
    const a = loadArtifact(contractsDir, n);
    return [n, asDeployed(a.deployedBytecode, a.immutableRanges)];
  }),
);
const A2B4412_CODE: Record<string, Hex> = {
  ...THIS_CODE,
  ...Object.fromEntries(Object.entries(A2B4412.contracts).map(([n, c]) => [n, asDeployed(c.deployedBytecode, Object.values(c.immutableReferences).flat())])),
};
const DIFFERS = ["Base CascadeFrontDoor: deployed code differs from the build", "Base CascadeStaker: deployed code differs from the build"];

const V3_TEST_COLDKEY: Hex = "0x34680a431a7295c7df20c0482c37e06788390d7c8ad1f6abb7693394a269a0fa";
const PEER: Hex = `0x${"5e".repeat(32)}`;
const VAULT_VIEWS = parseAbi([
  "function coldkey() view returns (bytes32)",
  "function peerId(uint64 chain, address addr) pure returns (bytes32)",
  "function frontDoorActive(bytes32) view returns (bool)",
  "function addressMapping(address addr) view returns (bytes32)",
]);

/** A plan as an earlier build made it: the same, without the `build` it now records. */
const unmarked = (p: PlanV3): PlanV3 => {
  const { build: _, ...rest } = p as PlanV3 & { build?: string };
  return rest as PlanV3;
};

const recordOf = (plan: PlanV3): DeploymentRecord => ({
  target: "live",
  wallet: WALLET,
  createdAt: "",
  plan,
  done: Object.fromEntries(plan.steps.map((s) => [s.id, { hash: `0x${"d0".repeat(32)}` as Hex, block: 1, gasUsed: 1n, costWei: 1n }])),
});

/** Chains that hold exactly what the plan asks for, with `code` at each contract's address; every request is counted. */
function chainsFor(rec: DeploymentRecord, code: Record<string, Hex>) {
  const plan = rec.plan as PlanV3;
  const exp = expectations(plan);
  const fns = [...CONTRACTS.flatMap((n) => loadArtifact(contractsDir, n).abi), ...VAULT_VIEWS].filter((i): i is AbiFunction => i.type === "function");
  const a = plan.addresses;
  const name: Record<string, string> = Object.fromEntries(
    (
      [
        ["base", a.baseAdapter, "CcipBaseAdapter"],
        ["base", a.oracle, "CascadeTwapOracle"],
        ["base", a.frontDoor, "CascadeFrontDoor"],
        ["base", a.staker, "CascadeStaker"],
        ["bittensor", a.bitAdapter, "CcipBittensorAdapter"],
        ["bittensor", a.vault, "CascadeVault"],
      ] as [ChainName, Address, string][]
    ).map(([c, addr, n]) => [`${c}:${addr.toLowerCase()}`, n]),
  );
  const activated = {
    address: a.vault,
    topics: encodeEventTopics({ abi: parseAbi(["event FrontDoorActivated(uint64 indexed chain, address indexed addr)"]), args: { chain: 8453n, addr: a.frontDoor } }),
    data: "0x",
  };
  const calls: string[] = [];
  const rpc: Rpc = {
    async request(chain, method, params) {
      calls.push(method);
      if (method === "eth_getCode") return code[name[`${chain}:${(params[0] as string).toLowerCase()}`]] ?? "0x";
      if (method === "eth_getBalance") return numberToHex(10n ** 20n);
      if (method === "eth_getTransactionReceipt") return { logs: [activated] };
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const { to, data } = params[0] as { to: Address; data: Hex };
      const fn = fns.find((f) => toFunctionSelector(f) === data.slice(0, 10));
      if (!fn) throw new Error(`unexpected call ${data.slice(0, 10)}`);
      let result: unknown;
      if (fn.name === "coldkey" || fn.name === "addressMapping") result = `0x${"77".repeat(32)}`;
      else if (fn.name === "peerId") result = PEER;
      else if (fn.name === "frontDoorActive") result = true;
      else {
        const mine = exp.filter((e) => e.chain === chain && e.address.toLowerCase() === to.toLowerCase() && (e.fn ?? e.field) === fn.name);
        if (!mine.length) throw new Error(`nothing expected of ${fn.name} at ${to}`);
        result = mine[0].pick === undefined ? mine[0].expected : [...mine].sort((x, y) => x.pick! - y.pick!).map((e) => e.expected);
      }
      return encodeFunctionResult({ abi: [fn], functionName: fn.name, result } as never);
    },
  };
  return { ctx: { ...fakeChain([], {}).ctx, rpc }, calls };
}

const verifyOn = (rec: DeploymentRecord, code: Record<string, Hex>) => verify(chainsFor(rec, code).ctx, rec);

describe("verify compares each contract with the build its plan was deployed from", () => {
  const marked = buildPlanV3(5, 8, V3_TEST_COLDKEY);
  const old = unmarked(marked);

  it("the checked-in a2b4412 data holds the front door and staker, which differ from this build's", () => {
    expect(A2B4412.build).toBe("a2b4412");
    expect(Object.keys(A2B4412.contracts)).toEqual(["CascadeFrontDoor", "CascadeStaker"]);
    for (const n of ["CascadeFrontDoor", "CascadeStaker"]) {
      expect(A2B4412.contracts[n].deployedBytecode, n).not.toBe(loadArtifact(contractsDir, n).deployedBytecode);
    }
  });

  it("a new v3 plan records the build it is deployed from", () => {
    expect((marked as PlanV3 & { build?: string }).build).toBe("launch-cadence");
    expect((buildPlanV3(5, 8, V3_TEST_COLDKEY, "launch") as PlanV3 & { build?: string }).build).toBe("launch-cadence");
  });

  it("a plan with no build (deployed from a2b4412) verifies against a2b4412's front door and staker, with that build's immutable positions", async () => {
    expect(await verifyOn(recordOf(old), A2B4412_CODE)).toMatchObject({ ok: true, failures: [] });
  });

  it("the same plan given this build's front door and staker fails, naming both", async () => {
    expect(await verifyOn(recordOf(old), THIS_CODE)).toMatchObject({ ok: false, failures: DIFFERS });
  });

  it("a plan that records this build verifies against contracts/out, and fails given a2b4412's code", async () => {
    expect(await verifyOn(recordOf(marked), THIS_CODE)).toMatchObject({ ok: true, failures: [] });
    expect(await verifyOn(recordOf(marked), A2B4412_CODE)).toMatchObject({ ok: false, failures: DIFFERS });
  });

  it("every other contract is compared with this build either way", async () => {
    for (const [plan, code] of [
      [old, A2B4412_CODE],
      [marked, THIS_CODE],
    ] as const) {
      for (const n of ["CcipBaseAdapter", "CcipBittensorAdapter", "CascadeVault", "CascadeTwapOracle"]) {
        const chain = n === "CcipBittensorAdapter" || n === "CascadeVault" ? "Bittensor" : "Base";
        // one byte off at the end, outside every immutable
        const other = { ...code, [n]: `${code[n].slice(0, -2)}${code[n].endsWith("00") ? "01" : "00"}` as Hex };
        expect((await verifyOn(recordOf(plan), other)).failures, n).toEqual([`${chain} ${n}: deployed code differs from the build`]);
      }
    }
  });

  it("the live v3-test record's shape (no build, no cadence) takes the a2b4412 path", async () => {
    // planned by the a2b4412 build from the test wallet's nonces 5 (Base) and 8 (Bittensor)
    expect(Object.keys(old)).toEqual(["version", "baseNonce", "bitNonce", "addresses", "steps"]);
    expect(old.addresses).toEqual({
      baseAdapter: "0x7c9Ceb476C50B4E4eCc1610d3cEe5d146c2bB9a0",
      oracle: "0x45614AE84875EFA577F21F85cf8a6abAA6B2f217",
      frontDoor: "0xDBe6aDCac889adcbE4D4230a82C8d719FB3C1f8B",
      staker: "0x5659c5929Dfe7993f3db521582B0201d6bf246B7",
      bitAdapter: "0x5659c5929Dfe7993f3db521582B0201d6bf246B7",
      vault: "0x32f4c98ACb181a80343CC0925b4202C35e0EB6e3",
    });
    const path = join(mkdtempSync(join(tmpdir(), "ops-verify-")), "v3-test.json");
    saveRecord(path, { ...recordOf(old), verify: { ok: true, failures: [], checkedAt: "2026-10-26T15:31:37.005Z" }, messages: [] });
    const rec = loadRecord(path)!;
    expect(await verifyOn(rec, A2B4412_CODE)).toMatchObject({ ok: true, failures: [] });
    expect((await verifyOn(rec, THIS_CODE)).failures).toEqual(DIFFERS);
  });

  it("refuses a plan from a build this tool does not know, before reading anything", async () => {
    const rec = recordOf({ ...marked, build: "someday" } as PlanV3);
    const chains = chainsFor(rec, THIS_CODE);
    await expect(verify(chains.ctx, rec)).rejects.toThrow(/contracts build "someday" this tool does not know/);
    expect(chains.calls).toEqual([]);
  });
});
