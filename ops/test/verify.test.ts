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
  getAddress,
  numberToHex,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import { describe, expect, it } from "vitest";
import { ROLES } from "./launch-roles.ts";
import { loadArtifact } from "../src/artifacts.ts";
import { POOL_ABI } from "../src/cardinality.ts";
import { type ChainName, paths, WALLET } from "../src/config.ts";
import { buildPlan, buildPlanV3, type PlanV3 } from "../src/plan.ts";
import { type DeploymentRecord, loadRecord, saveRecord } from "../src/record.ts";
import type { Rpc } from "../src/rpc.ts";
import {
  activationLogs,
  adapterCapFailures,
  codeMismatch,
  compare,
  type Expectation,
  expectations,
  frontDoorActivationFailures,
  keyOf,
  limitExpectations,
  readBack,
  reserveFailures,
  roleAccounts,
  roleCodeChecks,
  roleCodeFindings,
  v3AddressFailures,
  verify,
  verifyAndSave,
} from "../src/verify.ts";
import { fakeChain } from "./fake-keeper.ts";

const plan = buildPlan(0, 0, `0x${"33".repeat(32)}`);
const plan3 = buildPlanV3(0, 40, `0x${"33".repeat(32)}`);
const OTHER: Address = "0x0000000000000000000000000000000000000001";
/** Where a thief's sweeper code would live: what a stolen key delegates a role's plain account to. */
const SWEEPER = getAddress("0x00000000000000000000000000000000005eeeee");
/** A plain account's code once its key has signed an EIP-7702 delegation to SWEEPER: 23 bytes. */
const DELEGATED: Hex = `0xef0100${SWEEPER.slice(2).toLowerCase()}`;
/** A Safe's or a timelock's code. */
const SAFE: Hex = "0x6080604052";

/** A value of the same type that differs from `v`. */
const wrong = (v: unknown): unknown =>
  typeof v === "bigint" ? v + 1n : typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : v === OTHER ? WALLET : OTHER;

describe("verify v3", () => {
  const exp3 = expectations(plan3);
  const v2Keys = new Set(expectations(plan).map(keyOf));
  const added = exp3.filter((e) => !v2Keys.has(keyOf(e)));
  const expected = (contract: string, field: string) => exp3.find((e) => e.contract === contract && e.field === field)?.expected;

  it("reads back every v3 setting: the adapters' caps, front door, staker, oracle and the vault's reward cut", () => {
    expect(added.map((e) => `${e.contract}.${e.field}`)).toEqual([
      "CcipBaseAdapter.maxMessageValue",
      "CcipBittensorAdapter.maxMessageValue",
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
    expect([expected("CcipBaseAdapter", "maxMessageValue"), expected("CcipBittensorAdapter", "maxMessageValue")]).toEqual([5_000n * 10n ** 18n, 5_000n * 10n ** 18n]);
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
    const treasury = (chain: ChainName, code: Hex) => roleCodeFindings(chain, WALLET, ["treasury"], code);
    expect(treasury("base", "0x")).toEqual({ failures: [], warnings: [] });
    expect(treasury("base", "0x6080").failures).toEqual([
      `Base treasury ${WALLET}: has contract code; the treasury must be a plain account, the same owner on Base and Bittensor`,
    ]);
    expect(treasury("bittensor", "0x6080").failures).toEqual([
      `Bittensor treasury ${WALLET}: has contract code; the treasury must be a plain account, the same owner on Base and Bittensor`,
    ]);
    expect(treasury("base", DELEGATED).failures).toEqual([
      `Base treasury ${WALLET}: has an EIP-7702 delegation to ${SWEEPER}, code its own key installed; assume the key is compromised and rotate the treasury`,
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
    // the scan starts at the Bittensor adapter's block
    const rec = { target: "live" as const, wallet: WALLET, createdAt: "", plan, done: { bitAdapter: { recovered: true as const, block: 5 }, vault: { recovered: true as const, block: 5 } } };
    const logs = await activationLogs({ rpc } as never, rec);
    expect(frontDoorActivationFailures(logs, plan)).toEqual([]);
  });
});

type Ranges = { start: number; length: number }[];
/** The a2b4412 build's contracts that differ from this build's, read straight from the checked-in data. */
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
/** This build's code for all six contracts, and a2b4412's: its own adapters, front door, staker and vault, the oracle the same. */
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
/** What verify says of the five contracts the two builds differ in, in its order. */
const DIFFERS = [
  "Base CcipBaseAdapter: deployed code differs from the build",
  "Base CascadeFrontDoor: deployed code differs from the build",
  "Bittensor CcipBittensorAdapter: deployed code differs from the build",
  "Bittensor CascadeVault: deployed code differs from the build",
  "Base CascadeStaker: deployed code differs from the build",
];

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
  const exp = [...expectations(plan), ...limitExpectations(plan)];
  const fns = [...CONTRACTS.flatMap((n) => loadArtifact(contractsDir, n).abi), ...VAULT_VIEWS, ...POOL_ABI].filter((i): i is AbiFunction => i.type === "function");
  /** A clean deployment's state for the reads beyond the expectations: nothing pending, nothing extra, not
   * paused, and both of the oracle's pools at the target's 1,800 observation slots. */
  const clean: Record<string, unknown> = {
    pendingOwner: zeroAddress,
    guardianProposedAt: 0n,
    bridgeEnabled: true,
    bridgeProposedAt: 0n,
    paused: false,
    hotkeyCount: 1n,
    slot0: [2n ** 96n, 0, 0, 1_800, 1_800, 0, true],
  };
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
      // the registry scan: no registry events since the deployment
      if (method === "eth_blockNumber") return numberToHex(100);
      if (method === "eth_getLogs") return [];
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const { to, data } = params[0] as { to: Address; data: Hex };
      const fn = fns.find((f) => toFunctionSelector(f) === data.slice(0, 10));
      if (!fn) throw new Error(`unexpected call ${data.slice(0, 10)}`);
      let result: unknown;
      if (fn.name === "coldkey" || fn.name === "addressMapping") result = `0x${"77".repeat(32)}`;
      else if (fn.name === "peerId") result = PEER;
      else if (fn.name === "frontDoorActive") result = true;
      else if (fn.name in clean) result = clean[fn.name];
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

  it("the checked-in a2b4412 data holds the adapters, front door, staker and vault, which differ from this build's", () => {
    expect(A2B4412.build).toBe("a2b4412");
    expect(Object.keys(A2B4412.contracts)).toEqual(["CcipBaseAdapter", "CascadeFrontDoor", "CascadeStaker", "CcipBittensorAdapter", "CascadeVault"]);
    for (const n of Object.keys(A2B4412.contracts)) {
      expect(A2B4412.contracts[n].deployedBytecode, n).not.toBe(loadArtifact(contractsDir, n).deployedBytecode);
    }
    // the a2b4412 adapters have no per-message cap view; this build's do
    const capView = (code: Hex) => code.includes(toFunctionSelector("maxMessageValue()").slice(2));
    expect(capView(A2B4412.contracts.CcipBaseAdapter.deployedBytecode)).toBe(false);
    expect(capView(A2B4412.contracts.CcipBittensorAdapter.deployedBytecode)).toBe(false);
    expect(capView(loadArtifact(contractsDir, "CcipBaseAdapter").deployedBytecode)).toBe(true);
  });

  it("a new v3 plan records the build it is deployed from", () => {
    expect((marked as PlanV3 & { build?: string }).build).toBe("preaudit");
    expect((buildPlanV3(5, 8, V3_TEST_COLDKEY, "launch", ROLES) as PlanV3 & { build?: string }).build).toBe("preaudit");
  });

  it("a plan with no build (deployed from a2b4412) verifies against a2b4412's contracts, with that build's immutable positions", async () => {
    expect(await verifyOn(recordOf(old), A2B4412_CODE)).toMatchObject({ ok: true, failures: [] });
  });

  it("the same plan given this build's contracts fails, naming each that differs", async () => {
    expect(await verifyOn(recordOf(old), THIS_CODE)).toMatchObject({ ok: false, failures: DIFFERS });
  });

  it("a plan that records this build verifies against contracts/out, and fails given a2b4412's code", async () => {
    expect(await verifyOn(recordOf(marked), THIS_CODE)).toMatchObject({ ok: true, failures: [] });
    expect(await verifyOn(recordOf(marked), A2B4412_CODE)).toMatchObject({ ok: false, failures: DIFFERS });
  });

  it("each contract is compared with its build's code: one byte off fails it", async () => {
    for (const [plan, code] of [
      [old, A2B4412_CODE],
      [marked, THIS_CODE],
    ] as const) {
      for (const n of CONTRACTS) {
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

  it("saves only the read-back, into the record as it is on disk after the slow reads, and never into another deployment's", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ops-verify-")), "v3-test.json");
    const rec = recordOf(marked);
    const MSG: Hex = `0x${"5a".repeat(32)}`;
    /** The chains, with `meanwhile` saved to the record by another command (a run's close) at the first read. */
    const during = (meanwhile: () => DeploymentRecord) => {
      const chains = chainsFor(rec, THIS_CODE);
      let saved = false;
      const request: Rpc["request"] = (chain, method, params) => {
        if (!saved) saveRecord(path, meanwhile());
        saved = true;
        return chains.ctx.rpc.request(chain, method, params);
      };
      return { ...chains.ctx, rpc: { request } };
    };
    saveRecord(path, rec);
    const withMessage = () => ({ ...loadRecord(path)!, messages: [{ id: MSG, direction: "Base → Bittensor" as const, hash: MSG, at: "" }] });
    expect(await verifyAndSave(during(withMessage), path, rec)).toBe(true);
    const after = loadRecord(path)!;
    expect(after.verify).toMatchObject({ ok: true, failures: [] });
    expect(after.messages?.map((m) => m.id)).toEqual([MSG]);
    // the file now holds another deployment: nothing is saved into it
    const other = recordOf(buildPlanV3(6, 9, V3_TEST_COLDKEY));
    await expect(verifyAndSave(during(() => other), path, rec)).rejects.toThrow(`${path} now holds another deployment; the read-back was not saved`);
    expect(loadRecord(path)).toEqual(other);
  });

  it("refuses a plan from a build this tool does not know, before reading anything", async () => {
    // launch-cadence, the build before the pre-audit changes, was never deployed and is no longer carried
    for (const build of ["someday", "launch-cadence"]) {
      const rec = recordOf({ ...marked, build } as PlanV3);
      const chains = chainsFor(recordOf(marked), THIS_CODE);
      await expect(verify(chains.ctx, rec)).rejects.toThrow(`contracts build "${build}" this tool does not know (an unfinished plan can be replaced with deploy --new-plan)`);
      expect(chains.calls).toEqual([]);
    }
  });
});

describe("verify checks the adapters' per-message caps", () => {
  const TAO = 10n ** 18n;
  const marked = buildPlanV3(5, 8, V3_TEST_COLDKEY);
  const old = unmarked(marked);
  const capSel = toFunctionSelector("maxMessageValue()");
  /** The chains, with `answer` overriding the calls it returns a value for (by selector and address). */
  const overriding = (rec: DeploymentRecord, code: Record<string, Hex>, answer: (to: Address, data: Hex) => Promise<unknown> | undefined) => {
    const chains = chainsFor(rec, code);
    const request = chains.ctx.rpc.request;
    const rpc: Rpc = {
      request: (c, m, p) => {
        const { to, data } = (p[0] ?? {}) as { to: Address; data: Hex };
        return (m === "eth_call" && answer(to, data)) || request(c, m, p);
      },
    };
    return { ...chains.ctx, rpc };
  };
  const isAdapter = (plan: PlanV3, to: Address) => [plan.addresses.baseAdapter, plan.addresses.bitAdapter].some((x) => x.toLowerCase() === to.toLowerCase());

  it("an a2b4412 record's adapters, which have no maxMessageValue(), pass on their constant MAX_MESSAGE_VALUE", async () => {
    // as on chain: the old adapters revert on maxMessageValue()
    const ctx = overriding(recordOf(old), A2B4412_CODE, (to, data) => (data.startsWith(capSel) && isAdapter(old, to) ? Promise.reject(new Error("execution reverted")) : undefined));
    expect(await verify(ctx, recordOf(old))).toMatchObject({ ok: true, failures: [] });
    const fields = expectations(old).filter((e) => e.contract.startsWith("Ccip") && /message/i.test(e.field));
    expect(fields.map((e) => [e.contract, e.field, e.expected])).toEqual([
      ["CcipBaseAdapter", "MAX_MESSAGE_VALUE", 5_000n * TAO],
      ["CcipBittensorAdapter", "MAX_MESSAGE_VALUE", 5_000n * TAO],
    ]);
  });

  it("a record of this build whose adapter has no maxMessageValue() fails, saying so", async () => {
    const ctx = overriding(recordOf(marked), THIS_CODE, (to, data) =>
      data.startsWith(capSel) && to.toLowerCase() === marked.addresses.bitAdapter.toLowerCase() ? Promise.reject(new Error("execution reverted")) : undefined,
    );
    const r = await verify(ctx, recordOf(marked));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([
      `Bittensor CcipBittensorAdapter.maxMessageValue: expected ${5_000n * TAO}, found unreadable (execution reverted)`,
      "the adapters' per-message caps are not checked: CcipBittensorAdapter.maxMessageValue couldn't be read",
    ]);
  });

  it("a vault or front door limit raised past an adapter's cap fails", async () => {
    // the vault's payout message raised to 5,000 TAO, past a Bittensor adapter deployed with 4,500
    const v = toFunctionSelector("maxMessageValue()");
    const ctx = overriding(recordOf(marked), THIS_CODE, (to, data) => {
      if (!data.startsWith(v)) return undefined;
      if (to.toLowerCase() === marked.addresses.vault.toLowerCase()) return Promise.resolve(numberToHex(5_000n * TAO, { size: 32 }));
      if (to.toLowerCase() === marked.addresses.bitAdapter.toLowerCase()) return Promise.resolve(numberToHex(4_500n * TAO, { size: 32 }));
      return undefined;
    });
    const r = await verify(ctx, recordOf(marked));
    expect(r.failures).toEqual([
      `Bittensor CcipBittensorAdapter.maxMessageValue: expected ${5_000n * TAO}, found ${4_500n * TAO}`,
      `Bittensor CascadeVault.maxMessageValue: expected ${4_000n * TAO}, found ${5_000n * TAO}`,
      "Bittensor CcipBittensorAdapter.maxMessageValue (4500 TAO) is below the vault's maxMessageValue (5000 TAO): a payout message that size could never be sent",
    ]);
  });

  it("checks each rule on the values read back, under the view the plan's adapters have", () => {
    const launch = buildPlanV3(5, 8, V3_TEST_COLDKEY, "launch", ROLES);
    const right = (plan: PlanV3) => new Map([...expectations(plan), ...limitExpectations(plan)].map((e) => [keyOf(e), e.expected]));
    expect(adapterCapFailures(launch, right(launch))).toEqual([]);
    expect(adapterCapFailures(marked, right(marked))).toEqual([]);
    expect(adapterCapFailures(old, right(old))).toEqual([]);
    const at = (chain: ChainName, contract: string, field: string) => keyOf({ chain, contract, field });
    // a launch's front door raised to 60 TAO batches, past both 50 TAO caps
    const bigBatch = new Map(right(launch)).set(at("base", "CascadeFrontDoor", "maxBatchValue"), 60n * TAO);
    expect(adapterCapFailures(launch, bigBatch)).toEqual([
      "Base CcipBaseAdapter.maxMessageValue (50 TAO) is below the front door's maxBatchValue (60 TAO): a full batch could never be sent",
      "Bittensor CcipBittensorAdapter.maxMessageValue (50 TAO) is below the front door's maxBatchValue (60 TAO): a bounced batch could never be paid back",
    ]);
    // the old adapters' constant is read and named
    const oldBig = new Map(right(old)).set(at("bittensor", "CascadeVault", "maxEntryValue"), 5_001n * TAO);
    expect(adapterCapFailures(old, oldBig)).toEqual([
      "Bittensor CcipBittensorAdapter.MAX_MESSAGE_VALUE (5000 TAO) is below the vault's maxEntryValue (5001 TAO): a payout entry that size could never be sent",
    ]);
    // viem reads small uints as numbers: compared by value
    const asNumber = new Map(right(launch)).set(at("base", "CcipBaseAdapter", "minSendAmount"), 1);
    expect(adapterCapFailures(launch, asNumber)).toEqual([]);
  });
});

describe("verify reads back the registries, the pending proposals and the state", () => {
  const plan = buildPlanV3(5, 8, V3_TEST_COLDKEY);

  it("passes a clean deployment, keeping where the registry scan reached for the next read-back", async () => {
    const r = await verifyOn(recordOf(plan), THIS_CODE);
    expect(r).toMatchObject({ ok: true, failures: [] });
    expect(r.warnings).toBeUndefined();
    // the fake head is block 100: Base settles 30 blocks back, Bittensor 10
    expect(r.registryScan).toEqual({ base: { to: 70, bridges: [], routes: [] }, bittensor: { to: 90, bridges: [], frontDoors: [] } });
  });

  it("the next read-back scans only from where the last settled", async () => {
    const prev = { base: { to: 95, bridges: [], routes: [0] }, bittensor: { to: 99, bridges: [], frontDoors: [] } };
    const rec = { ...recordOf(plan), verify: { ok: true, failures: [], checkedAt: "", registryScan: prev } };
    const chains = chainsFor(rec, THIS_CODE);
    const r = await verify(chains.ctx, rec);
    expect(r.registryScan).toEqual(prev);
    expect(chains.calls.filter((m) => m === "eth_getLogs")).toHaveLength(2);
  });

  it("a registry scan the logs server refuses is unchecked, said loudly, and doesn't fail the read-back (which would stop the keeper)", async () => {
    const chains = chainsFor(recordOf(plan), THIS_CODE);
    const request = chains.ctx.rpc.request;
    const refusing = (chain: string): Rpc => ({
      request: (c, m, p) => (m === "eth_getLogs" && c === chain ? Promise.reject(new Error("range too large")) : request(c, m, p)),
    });
    const base = await verify({ ...chains.ctx, rpc: refusing("base") }, recordOf(plan));
    expect(base).toMatchObject({ ok: true, failures: [] });
    expect(base.unchecked).toEqual([
      "Base: the front door's and the staker's registry events from block 1 (range too large) couldn't be read, so bridges and routes proposed or enabled since then are NOT checked; the next verify resumes there. OPS_BASE_LOGS_RPC must serve eth_getLogs that far back",
    ]);
    // nothing was read on Base: the next verify starts there again; Bittensor moved on
    expect(base.registryScan).toEqual({ base: { to: 0, bridges: [], routes: [] }, bittensor: { to: 90, bridges: [], frontDoors: [] } });
    const bit = await verify({ ...chains.ctx, rpc: refusing("bittensor") }, recordOf(plan));
    expect(bit).toMatchObject({ ok: true, failures: [] });
    expect(bit.unchecked).toEqual([expect.stringMatching(/^Bittensor: the vault's registry events from block 1 \(range too large\) couldn't be read/)]);
    // printed loudly when saved
    const lines: string[] = [];
    const path = join(mkdtempSync(join(tmpdir(), "ops-verify-")), "v3-test.json");
    saveRecord(path, recordOf(plan));
    await verifyAndSave({ ...chains.ctx, rpc: refusing("base"), log: (l) => void lines.push(l) }, path, recordOf(plan));
    expect(lines.join("\n")).toMatch(/NOT CHECKED — the read-back passes without these.*\n {2}Base: the front door's and the staker's registry events/);
  });

  it("a gap older than the 7-day registry delay fails the read-back: a proposal made in it could be active", async () => {
    const chains = chainsFor(recordOf(plan), THIS_CODE);
    const request = chains.ctx.rpc.request;
    const T = 1_800_000_000;
    const rpc: Rpc = {
      request: (c, m, p) => {
        if (m === "eth_getLogs" && c === "base") return Promise.reject(new Error("range too large"));
        // the gap's first block is 8 days old
        if (m === "eth_getBlockByNumber") return Promise.resolve({ timestamp: numberToHex(p[0] === "latest" ? T : T - 8 * 86_400) });
        return request(c, m, p);
      },
    };
    const r = await verify({ ...chains.ctx, rpc }, recordOf(plan));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([expect.stringMatching(/^Base: the front door's and the staker's registry events from block 1 .*; the gap began 8 days ago, beyond the 7-day registry delay/)]);
    expect(r.unchecked).toBeUndefined();
  });

  it("while the scan is refused, an extra bridge it found before still fails", async () => {
    const extra = getAddress("0x00000000000000000000000000000000000000e1");
    const prev = { base: { to: 50, bridges: [extra], routes: [0] }, bittensor: { to: 99, bridges: [], frontDoors: [] } };
    const rec = { ...recordOf(plan), verify: { ok: true, failures: [], checkedAt: "", registryScan: prev } };
    const chains = chainsFor(rec, THIS_CODE);
    const request = chains.ctx.rpc.request;
    const rpc: Rpc = { request: (c, m, p) => (m === "eth_getLogs" ? Promise.reject(new Error("refused")) : request(c, m, p)) };
    const r = await verify({ ...chains.ctx, rpc }, rec);
    // the fake chain reads every bridge as enabled
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([`Base CascadeFrontDoor: an extra bridge ${extra} is enabled, beyond the plan's (if meant, add it to OPS_VERIFY_ALLOW)`]);
    expect(r.unchecked).toHaveLength(2);
    expect(r.registryScan).toEqual(prev);
  });

  it("other checks it cannot read still fail, saying so", async () => {
    const chains = chainsFor(recordOf(plan), THIS_CODE);
    const request = chains.ctx.rpc.request;
    const pendingOwner = toFunctionSelector("pendingOwner()");
    const rpc: Rpc = {
      request: (c, m, p) => (m === "eth_call" && (p[0] as { data: Hex }).data.startsWith(pendingOwner) ? Promise.reject(new Error("node down")) : request(c, m, p)),
    };
    const r = await verify({ ...chains.ctx, rpc }, recordOf(plan));
    expect(r.failures).toEqual(["the owners: could not be read (node down)"]);
  });

  it("names a wrong limit like any other setting", async () => {
    const chains = chainsFor(recordOf(plan), THIS_CODE);
    const request = chains.ctx.rpc.request;
    const minDaily = toFunctionSelector("minDailyOutflow()");
    const rpc: Rpc = {
      request: (c, m, p) =>
        m === "eth_call" && (p[0] as { data: Hex }).data.startsWith(minDaily) ? Promise.resolve(numberToHex(5n * 10n ** 18n, { size: 32 })) : request(c, m, p),
    };
    const r = await verify({ ...chains.ctx, rpc }, recordOf(plan));
    expect(r.failures).toEqual([`Bittensor CascadeVault.minDailyOutflow: expected ${100n * 10n ** 18n}, found ${5n * 10n ** 18n}`]);
  });
});

describe("verify reads each role's account by its code", () => {
  const launch = buildPlanV3(5, 8, V3_TEST_COLDKEY, "launch", ROLES);
  const test = buildPlanV3(5, 8, V3_TEST_COLDKEY);
  const at = (chain: ChainName, a: Address) => `${chain}:${a.toLowerCase()}`;
  /** Chains where each account in `code` (by `at`) holds that code, and every other none; the reads kept. */
  const codes = (code: Record<string, Hex>) => {
    const asked: string[] = [];
    const rpc: Rpc = {
      async request(chain, method, params) {
        if (method !== "eth_getCode") throw new Error(`unexpected ${method}`);
        asked.push(at(chain, params[0] as Address));
        return code[at(chain, params[0] as Address)] ?? "0x";
      },
    };
    return { ctx: { rpc }, asked };
  };
  /** A launch's owners as Safes (or timelocks), every other role a plain account. */
  const safeOwners = { [at("base", ROLES.owner.base)]: SAFE, [at("bittensor", ROLES.owner.bittensor)]: SAFE };
  const delegated = (where: string, roles: string) =>
    `${where}: has an EIP-7702 delegation to ${SWEEPER}, code its own key installed; assume the key is compromised and rotate the ${roles}`;

  it("reads each role on the chains where it acts: the keeper and the treasury on both, each chain's owner and guardian on it", () => {
    expect(roleAccounts(launch)).toEqual([
      { chain: "base", address: ROLES.owner.base, roles: ["owner"] },
      { chain: "base", address: ROLES.guardian.base, roles: ["guardian"] },
      { chain: "base", address: ROLES.keeper, roles: ["keeper"] },
      { chain: "base", address: ROLES.treasury, roles: ["treasury"] },
      { chain: "bittensor", address: ROLES.owner.bittensor, roles: ["owner"] },
      { chain: "bittensor", address: ROLES.guardian.bittensor, roles: ["guardian"] },
      { chain: "bittensor", address: ROLES.keeper, roles: ["keeper"] },
      { chain: "bittensor", address: ROLES.treasury, roles: ["treasury"] },
    ]);
    // the test plan's wallet holds every role: one account a chain; a treasury the contracts name besides is read too
    expect(roleAccounts(test, [WALLET.toLowerCase() as Address, OTHER])).toEqual([
      { chain: "base", address: WALLET, roles: ["owner", "guardian", "keeper", "treasury"] },
      { chain: "base", address: OTHER, roles: ["treasury"] },
      { chain: "bittensor", address: WALLET, roles: ["owner", "guardian", "keeper", "treasury"] },
      { chain: "bittensor", address: OTHER, roles: ["treasury"] },
    ]);
  });

  it("passes a launch whose owners are Safes (a guardian may be one too) and the rest plain accounts, and the test plan's plain wallet", async () => {
    expect(await roleCodeChecks(codes(safeOwners).ctx, launch)).toEqual({ failures: [], warnings: [] });
    expect(await roleCodeChecks(codes({ ...safeOwners, [at("base", ROLES.guardian.base)]: SAFE }).ctx, launch)).toEqual({ failures: [], warnings: [] });
    const t = codes({});
    expect(await roleCodeChecks(t.ctx, test)).toEqual({ failures: [], warnings: [] });
    expect(t.asked).toEqual([at("base", WALLET), at("bittensor", WALLET)]);
  });

  it("fails any role whose account holds an EIP-7702 delegation, naming the role and the chain: even an owner or a guardian", async () => {
    const r = await roleCodeChecks(
      codes({
        [at("base", ROLES.owner.base)]: DELEGATED,
        [at("bittensor", ROLES.owner.bittensor)]: SAFE,
        [at("base", ROLES.guardian.base)]: DELEGATED,
        [at("bittensor", ROLES.keeper)]: DELEGATED,
        [at("bittensor", ROLES.treasury)]: DELEGATED,
      }).ctx,
      launch,
    );
    expect(r).toEqual({
      failures: [
        delegated(`Base owner ${ROLES.owner.base}`, "owner"),
        delegated(`Base guardian ${ROLES.guardian.base}`, "guardian"),
        delegated(`Bittensor keeper ${ROLES.keeper}`, "keeper"),
        delegated(`Bittensor treasury ${ROLES.treasury}`, "treasury"),
      ],
      warnings: [],
    });
  });

  it("fails the keeper or the treasury holding any other code, where an owner or a guardian may", async () => {
    const r = await roleCodeChecks(
      codes({ ...safeOwners, [at("base", ROLES.keeper)]: SAFE, [at("bittensor", ROLES.treasury)]: SAFE, [at("bittensor", ROLES.guardian.bittensor)]: SAFE }).ctx,
      launch,
    );
    expect(r).toEqual({
      failures: [
        `Base keeper ${ROLES.keeper}: has contract code; the keeper must be a plain account, whose own key signs the keeper's transactions`,
        `Bittensor treasury ${ROLES.treasury}: has contract code; the treasury must be a plain account, the same owner on Base and Bittensor`,
      ],
      warnings: [],
    });
  });

  it("warns, without failing, when a launch's owner has no code: a plain account, where a Safe or a timelock was planned", async () => {
    const r = await roleCodeChecks(codes({ [at("base", ROLES.owner.base)]: SAFE }).ctx, launch);
    expect(r).toEqual({
      failures: [],
      warnings: [
        `Bittensor owner ${ROLES.owner.bittensor}: has no code, so it is a plain account, not a Safe or a timelock; if one was meant, none is deployed at this address on Bittensor`,
      ],
    });
  });

  it("one wallet in every role fails once, naming each", async () => {
    expect((await roleCodeChecks(codes({ [at("base", WALLET)]: DELEGATED }).ctx, test)).failures).toEqual([
      delegated(`Base owner, guardian, keeper and treasury ${WALLET}`, "owner, guardian, keeper and treasury"),
    ]);
  });

  it("verify reads them back: the test wallet with a delegation fails it, and code it can't read fails it, saying so", async () => {
    const rec = recordOf(test);
    const chains = chainsFor(rec, THIS_CODE);
    const request = chains.ctx.rpc.request;
    const wallet = (answer: () => Promise<unknown>): Rpc => ({
      request: (c, m, p) => (m === "eth_getCode" && c === "base" && (p[0] as string).toLowerCase() === WALLET.toLowerCase() ? answer() : request(c, m, p)),
    });
    expect(await verify({ ...chains.ctx, rpc: wallet(async () => "0x") }, rec)).toMatchObject({ ok: true, failures: [] });
    expect(await verify({ ...chains.ctx, rpc: wallet(async () => DELEGATED) }, rec)).toMatchObject({
      ok: false,
      failures: [delegated(`Base owner, guardian, keeper and treasury ${WALLET}`, "owner, guardian, keeper and treasury")],
    });
    expect(await verify({ ...chains.ctx, rpc: wallet(() => Promise.reject(new Error("node down"))) }, rec)).toMatchObject({
      ok: false,
      failures: ["the roles' accounts: could not be read (node down)"],
    });
  });
});
