import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AbiParameter, type Address, encodeAbiParameters, encodePacked, getAddress, getContractAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_V3, LIVE, paths, WALLET } from "../src/config.ts";
import { decodeSs58 } from "../src/ss58.ts";
import { halfInBlocks, MS_PER_BLOCK_PINS } from "../src/v32/classes.ts";
import {
  addressMapping,
  buildPlanV32,
  CONTRACTS_V32,
  createAddressV32,
  LINKS_V32,
  NONCE_PLAN,
  type PlanV32,
  type PlannedStepV32,
  plannedAddressesV32,
  type V32StepId,
} from "../src/v32/plan.ts";
import {
  BOUNDS_V32,
  capRelationProblemsV32,
  capsWarning,
  deployerKeysFromEnv,
  msPerBlockProblems,
  FOUNDER_LEVEL,
  keeperFromEnv,
  parseHotkey,
  ROLES_V32_LAUNCH,
  rolesV32FromEnv,
  SETTINGS_V32_LAUNCH,
  type SettingsV32,
  SINGLE_KEY_RESIDUAL,
  V3_LAUNCH_KEEPER,
  type V32Roles,
  validatorsFromEnv,
} from "../src/v32/settings.ts";
import {
  abAddress,
  abBps,
  abDays,
  abEth,
  abHours,
  abInt,
  abPair,
  abMsPerBlock,
  abTao,
  abUsdc,
  appendixB,
  artifact,
  constructorInputs,
  constructorLeaves,
  defaultParamsLaunchValues,
  libraryLinks,
  solConstant,
  solEnumIndex,
  specText,
} from "./v32-sources.ts";

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);

/** Obvious placeholders for the owner, guardian and keeper (never real accounts); the treasury is Appendix B's. */
const ROLES: V32Roles = { owner: at("a0b1"), guardian: at("b0b1"), keeper: at("c0c1"), treasury: SETTINGS_V32_LAUNCH.treasury };
const DEPLOYERS = { base: getAddress(`0x${"d1".repeat(20)}`), bittensor: getAddress(`0x${"d2".repeat(20)}`) };
/** tao.bot's hotkey (v3-launch's) and Yuma's, the validators the founder chose (configuration, not constants). */
const TAO_BOT_SS58 = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";
const TAO_BOT: Hex = "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748";
const YUMA_SS58 = "5DXdHixxtCvoa6GHKs2Jgrdzc61882Ftx1zN2sYFQuwgL1S1";
const YUMA: Hex = "0x40c47b6a294686fe9612b5d78dd369f4c77fa3bbf96a4286ede97410ba2e3209";
const VALIDATORS = { primary: TAO_BOT, standby: YUMA };
const FLOORS: [bigint, bigint] = [10n ** 20n, 10n ** 17n];
const CLAIM_GAS = 55_000_000n;

/** The vault's address by its own nonce (6: after the adapter and the five libraries), computed here. */
const VAULT = getContractAddress({ from: DEPLOYERS.bittensor, nonce: 6n });

const inputs = (over: Partial<Parameters<typeof buildPlanV32>[0]> = {}) => ({
  deployers: DEPLOYERS,
  roles: ROLES,
  validators: VALIDATORS,
  vaultColdkey: addressMapping(VAULT),
  poolFloors: FLOORS,
  claimGasRequired: CLAIM_GAS,
  ...over,
});

const plan: PlanV32 = buildPlanV32(inputs());
const step = (id: V32StepId): PlannedStepV32 => {
  const s = plan.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no ${id} step`);
  return s;
};
const nameOf = (s: PlannedStepV32) => s.contract.split(":")[1];
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

describe("v3.2 plan", () => {
  it("addressesFollowTheNoncePlan: Bittensor first, the adapter first on each chain, every address from its deployer's nonce", () => {
    // §7 step 2's order with the reserve lever used (L4 before the vault, every later nonce shifted)
    expect(plan.steps.map((s) => [s.chain, s.id])).toEqual([
      ["bittensor", "bitAdapter"],
      ["bittensor", "payoutMath"],
      ["bittensor", "stakeLib"],
      ["bittensor", "payoutLib"],
      ["bittensor", "batchLib"],
      ["bittensor", "hotkeyLib"],
      ["bittensor", "vault"],
      ["bittensor", "vaultLens"],
      ["base", "baseAdapter"],
      ["base", "oracle"],
      ["base", "frontDoor"],
      ["base", "staker"],
      ["base", "doorLens"],
    ]);
    for (const chain of ["bittensor", "base"] as const) {
      const steps = plan.steps.filter((s) => s.chain === chain);
      steps.forEach((s, i) => {
        // fresh keys: each chain's nonces run from 0 with no gap
        expect(s.nonce).toBe(i);
        expect(plan.addresses[s.id]).toBe(getContractAddress({ from: DEPLOYERS[chain], nonce: BigInt(i) }));
      });
    }
    expect(plan.addresses.vault).toBe(VAULT);
    // constructor-only: no step but a create (§7 step 4, "nothing to set")
    expect(plan.steps.every((s) => s.kind === "create")).toBe(true);
    // the lenses after their targets, the staker after the front door whose tokens it reads
    expect(step("vaultLens").nonce).toBeGreaterThan(step("vault").nonce);
    expect(step("doorLens").nonce).toBeGreaterThan(step("frontDoor").nonce);
    expect(step("staker").nonce).toBeGreaterThan(step("frontDoor").nonce);
    // each step names its artifact as the build compiled it
    for (const s of plan.steps) {
      const [path, name] = s.contract.split(":");
      expect(artifact(name).metadata.settings.compilationTarget).toEqual({ [path]: name });
    }
    expect(plan.deployers).toEqual(DEPLOYERS);
  });

  it("theOrderFollowsTheBuildsLinkGraph: every library the build links, before every create that links it, at its planned address", () => {
    const graph = libraryLinks();
    // the generated file names the vault's and L3's links (and VaultInternals', a test contract no plan deploys)
    expect(graph.CascadeVault).toEqual(["CascadeBatchLib", "CascadeHotkeyLib", "CascadePayoutLib", "CascadeStakeLib"]);
    expect(graph.CascadePayoutLib).toEqual(["CascadePayoutMath"]);
    const planned = new Set(plan.steps.map(nameOf));
    for (const linker of Object.keys(graph).filter((n) => n !== "VaultInternals")) expect(planned.has(linker)).toBe(true);
    // the libraries deployed are exactly those reachable from the vault through the graph: one added or removed fails
    const reach = new Set<string>();
    const walk = (n: string) => {
      for (const lib of graph[n] ?? []) if (!reach.has(lib)) reach.add(lib), walk(lib);
    };
    walk("CascadeVault");
    const libSteps = plan.steps.filter((s) => s.contract.startsWith("src/libraries/"));
    expect(libSteps.map(nameOf).sort()).toEqual([...reach].sort());
    for (const s of plan.steps) {
      const a = artifact(nameOf(s));
      // what the creation code links, by path:Name, as the build has it; the runtime code's (LibraryLinks.sol) agrees
      const creation = Object.entries(a.bytecode.linkReferences).flatMap(([file, libs]) => Object.keys(libs).map((lib) => `${file}:${lib}`));
      const linked = Object.keys(s.libraries ?? {});
      expect(linked.sort()).toEqual(creation.sort());
      expect(linked.map((k) => k.split(":")[1]).sort()).toEqual([...(graph[nameOf(s)] ?? [])].sort());
      for (const [lib, address] of Object.entries(s.libraries ?? {})) {
        const libStep = plan.steps.find((x) => x.contract === lib);
        expect(libStep, lib).toBeDefined();
        expect(libStep?.chain).toBe(s.chain);
        expect(libStep!.nonce).toBeLessThan(s.nonce);
        expect(address).toBe(plan.addresses[libStep!.id]);
      }
    }
    // the plan's own table of links says the same
    expect(Object.keys(LINKS_V32).sort()).toEqual(["payoutLib", "vault"]);
  });

  it("coldkeyIsThePredictedVaultsMapping: ADDRESS_MAPPING offline, the vault's coldkey from its nonce-6 address, a wrong one refused", () => {
    // three live vaults and their coldkeys (web/src/lib/cascade/deployments.json: v3-launch, v3-test, the v2 test)
    for (const [vault, ss58] of [
      ["0x450cD94401B45c72C09734071fe683F6b74Aea72", "5ELMyza1QBFKY1K6bbJXoPSENaiJVVTSQZBgdkQujxKpsfQn"],
      ["0x32f4c98ACb181a80343CC0925b4202C35e0EB6e3", "5DFRFf7grg31puQ47VnEVcv1DyutyxFBBLLDexbCcoAFn1Y2"],
      ["0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750", "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu"],
    ] as const) {
      expect(addressMapping(vault)).toBe(decodeSs58(ss58));
    }
    expect(plan.vaultColdkey).toBe(addressMapping(VAULT));
    expect((step("vault").args[0] as { expectedColdkey: Hex }).expectedColdkey).toBe(plan.vaultColdkey);
    // the pre-L4 slot (nonce 5) is the library's now: its mapping is refused
    const nonce5 = getContractAddress({ from: DEPLOYERS.bittensor, nonce: 5n });
    expect(() => buildPlanV32(inputs({ vaultColdkey: addressMapping(nonce5) }))).toThrow(/not the ADDRESS_MAPPING of its planned address/);
    // the caller's case does not matter
    expect(buildPlanV32(inputs({ vaultColdkey: addressMapping(VAULT).toUpperCase().replace("0X", "0x") as Hex })).vaultColdkey).toBe(addressMapping(VAULT));
  });

  it("everyParamEqualsAppendixB: each constructor's every parameter against Appendix B and DefaultParams' launch values", () => {
    const dp = defaultParamsLaunchValues();
    const gas = (name: string) => solConstant("contracts/test/adapters/AdapterGas.t.sol", name);
    const mspb = abMsPerBlock();
    const treasury = abAddress("treasury");
    const a = plan.addresses;
    type Want = { want: unknown; from: string; fixture?: unknown };
    const ab = (want: unknown, fixture?: unknown): Want => ({ want, from: fixture === undefined ? "Appendix B alone (DefaultParams sets none)" : "Appendix B = DefaultParams", fixture });
    const cfg = (want: unknown): Want => ({ want, from: "config.ts (live addresses)" });
    const planned = (want: unknown): Want => ({ want, from: "the plan's address by nonce" });
    const role = (want: unknown): Want => ({ want, from: "the plan's roles" });
    const input = (want: unknown, row: string): Want => {
      expect(appendixB(row)).toMatch(/measure/);
      return { want, from: "the plan's input (Appendix B: measured)" };
    };
    const ruled = (want: unknown): Want => ({ want, from: "AdapterGas.t.sol (no Appendix B row: the latest ruling, replaced by Task 65's measurements)" });
    const fdv = dp.frontDoor;
    const vv = dp.vault;
    const sv = dp.staker;
    expect(appendixB("route")).toBe("Uniswap USDC-WETH-TAO");
    const path = (x: Address, f1: number, y: Address, f2: number, z: Address) => encodePacked(["address", "uint24", "address", "uint24", "address"], [x, f1, y, f2, z]);
    const table: Record<V32StepId, Record<string, Want>> = {
      bitAdapter: {
        "c.router": cfg(LIVE.bittensor.ROUTER),
        "c.token": cfg(LIVE.bittensor.TOKEN),
        "c.localChainId": cfg(LIVE.bittensor.CHAIN_ID),
        "c.remoteChainId": cfg(LIVE.base.CHAIN_ID),
        "c.remoteSelector": cfg(LIVE.base.SELECTOR),
        "c.remoteAdapter": planned(a.baseAdapter),
        "c.gasBase": ruled(gas("GAS_BASE_TO_BASE")),
        "c.gasPerEntry": ruled(gas("GAS_PER_ENTRY_TO_BASE")),
        "c.maxMessageValue": ab(abTao("adapter caps")),
        "c.treasury": ab(treasury),
        alphaVault_: cfg(LIVE.ALPHA_VAULT),
        // the lane's inbound model, the Base adapter's own pair toward Bittensor (R4: deliverParked's gas requirement)
        inboundGasBase_: ruled(gas("GAS_BASE_TO_BITTENSOR")),
        inboundGasPerEntry_: ruled(gas("GAS_PER_ENTRY_TO_BITTENSOR")),
      },
      payoutMath: {},
      stakeLib: {},
      payoutLib: {},
      batchLib: {},
      hotkeyLib: {},
      vault: {
        "p.expectedColdkey": { want: addressMapping(VAULT), from: "ADDRESS_MAPPING of the vault's planned address" },
        "p.hotkey": { want: TAO_BOT, from: "the primary validator (configuration)" },
        "p.bridge": planned(a.bitAdapter),
        "p.owner": role(ROLES.owner),
        "p.guardian": role(ROLES.guardian),
        "p.keeper": role(ROLES.keeper),
        "p.treasury": ab(treasury),
        "p.rewardCutBps": ab(abBps("reward cut"), vv.rewardCutBps),
        "p.launchChain": ab(abInt("launchChain")),
        "p.initialFrontDoor": planned(a.frontDoor),
        "p.payoutDelay": ab(abHours("payout delay"), vv.payoutDelay),
        "p.maxDailyOutflowBps": ab(abBps("outflow bps"), vv.maxDailyOutflowBps),
        "p.minDailyOutflow": ab(abTao("floor"), vv.minDailyOutflow),
        "p.maxEntryValue": ab(abTao("maxEntryValue"), vv.maxEntryValue),
        "p.maxMessageValue": ab(abTao("maxMessageValue"), vv.maxMessageValue),
        "p.minChunk": ab(abInt("minChunk"), vv.minChunk),
        "p.maxFeeBps": ab(abBps("maxFeeBps"), vv.maxFeeBps),
        "p.maxFeeAbs": ab(abTao("maxFeeAbs"), vv.maxFeeAbs),
        "p.maxTotalAssets": ab(abTao("maxTotalAssets"), vv.maxTotalAssets),
        "p.minDirectDeposit": ab(abTao("minDirectDeposit"), vv.minDirectDeposit),
        // DefaultParams' 55,000,000 is a fixture's, not a launch value: Appendix B's is the testnet measurement
        "p.claimGasRequired": input(CLAIM_GAS, "claimGasRequired"),
        "p.hotkeyDustRao": ab(abInt("hotkeyDustRao", "rao"), vv.hotkeyDustRao),
        "p.unstakeMarginRao": ab(abInt("unstakeMarginRao"), vv.unstakeMarginRao),
        "p.msPerBlock": ab(mspb.vault, vv.msPerBlock),
        // DefaultParams' 7 days is the fixtures' (the contract tests' vesting arithmetic), not a launch value: Appendix
        // B's is 30 days since R4 (the vault-favour review)
        "p.rewardVesting": { want: abDays("rewardVesting"), from: "Appendix B (DefaultParams' 7 days is a fixture's)" },
        "p.globalOutflowBps": ab(abBps("globalOutflowBps"), vv.globalOutflowBps),
        "p.idleBufferBps": ab(abBps("idleBufferBps"), vv.idleBufferBps),
        "p.unstakeGas": ab(abInt("unstakeGas"), vv.unstakeGas),
      },
      vaultLens: { vault: planned(a.vault) },
      baseAdapter: {
        "c.router": cfg(LIVE.base.ROUTER),
        "c.token": cfg(LIVE.base.TOKEN),
        "c.localChainId": cfg(LIVE.base.CHAIN_ID),
        "c.remoteChainId": cfg(LIVE.bittensor.CHAIN_ID),
        "c.remoteSelector": cfg(LIVE.bittensor.SELECTOR),
        "c.remoteAdapter": planned(a.bitAdapter),
        "c.gasBase": ruled(gas("GAS_BASE_TO_BITTENSOR")),
        "c.gasPerEntry": ruled(gas("GAS_PER_ENTRY_TO_BITTENSOR")),
        "c.maxMessageValue": ab(abTao("adapter caps")),
        "c.treasury": ab(treasury),
        minSendAmount_: ab(abTao("Base adapter minSendAmount")),
      },
      oracle: {
        taoWethPool_: cfg(BASE_V3.TAO_WETH_POOL),
        wethUsdcPool_: cfg(BASE_V3.WETH_USDC_POOL),
        tao_: cfg(LIVE.base.TOKEN),
        weth_: cfg(BASE_V3.WETH),
        usdc_: cfg(BASE_V3.USDC),
      },
      frontDoor: {
        "p.asset": cfg(LIVE.base.TOKEN),
        "p.bridge": planned(a.baseAdapter),
        "p.vaultChain": cfg(LIVE.bittensor.CHAIN_ID),
        "p.vault": planned(a.vault),
        "p.usdc": cfg(BASE_V3.USDC),
        "p.owner": role(ROLES.owner),
        "p.guardian": role(ROLES.guardian),
        "p.keeper": role(ROLES.keeper),
        "p.oracle": planned(a.oracle),
        "p.swapper": planned(a.staker),
        "p.treasury": ab(treasury),
        // DefaultParams' floors are a fixture's: Appendix B's are measured at deploy
        "p.minPoolLiquidity": input(FLOORS, "minPoolLiquidity[0], [1]"),
        "p.batchInterval": ab(abHours("batch interval"), fdv.batchInterval),
        "p.minDeposit": ab(abTao("minimum deposit"), fdv.minDeposit),
        "p.depositCap": ab(abTao("deposit cap"), fdv.depositCap),
        // DefaultParams' 0.0001 ETH is the fixtures' (the contract tests' fee arithmetic), not a launch value: Appendix B's
        // is 0.0002 ETH since the founder's change of 2026-11-16
        "p.redeemRequestFee": { want: abEth("request fee"), from: "Appendix B (DefaultParams' 0.0001 ETH is a fixture's)" },
        "p.maxDeposits": ab(abPair("batch limits")[0], fdv.maxDeposits),
        "p.maxRedeems": ab(abPair("batch limits")[1], fdv.maxRedeems),
        "p.maxBatchValue": ab(abTao("batch value"), fdv.maxBatchValue),
        "p.maxDeliverySlippageBps": ab(abBps("delivery slippage"), fdv.maxDeliverySlippageBps),
        "p.msPerBlock": ab(mspb.frontDoor, fdv.msPerBlock),
      },
      staker: {
        "p.usdc": cfg(BASE_V3.USDC),
        "p.tao": cfg(LIVE.base.TOKEN),
        "p.frontDoor": planned(a.frontDoor),
        "p.owner": role(ROLES.owner),
        "p.treasury": ab(treasury),
        // Appendix B's route: Uniswap, USDC -> WETH -> TAO, through the oracle's two pools (0.05%, 0.3%)
        "p.route0.kind": ab(solEnumIndex("contracts/src/CascadeStaker.sol", "RouterKind", "UniswapV3")),
        "p.route0.router": cfg(BASE_V3.SWAP_ROUTER_02),
        "p.route0.buyPath": ab(path(BASE_V3.USDC, 500, BASE_V3.WETH, 3000, LIVE.base.TOKEN)),
        "p.route0.sellPath": ab(path(LIVE.base.TOKEN, 3000, BASE_V3.WETH, 500, BASE_V3.USDC)),
        "p.route0.active": ab(true),
        // Appendix B names the route, not its id: the only id the constructor can name is the active route's, 0
        "p.deliveryRouteId": { want: sv.deliveryRouteId, from: "DefaultParams (the only id the constructor accepts)" },
        "p.swapFeeBps": ab(abBps("swap fee"), sv.swapFeeBps),
        "p.depositFeeUsdc": ab(abUsdc("deposit fee"), sv.depositFeeUsdc),
      },
      doorLens: { frontDoor: planned(a.frontDoor) },
    };
    const norm = (x: unknown): unknown =>
      Array.isArray(x) ? x.map(norm) : typeof x === "bigint" || typeof x === "number" ? BigInt(x).toString() : typeof x === "string" ? x.toLowerCase() : x;
    const valueAt = (s: PlannedStepV32, ins: readonly AbiParameter[], leaf: string): unknown => {
      const [top, ...rest] = leaf.split(".");
      let v: unknown = s.args[ins.findIndex((p) => p.name === top)];
      for (const k of rest) v = (v as Record<string, unknown>)[k];
      return v;
    };
    const alone: string[] = [];
    for (const s of plan.steps) {
      const art = artifact(nameOf(s));
      const leaves = constructorLeaves(art);
      const rows = table[s.id];
      // every parameter the build's constructor takes has a source here, and nothing else does
      expect(Object.keys(rows).sort(), `${s.id}'s parameters`).toEqual([...leaves].sort());
      for (const leaf of leaves) {
        const { want, from, fixture } = rows[leaf];
        expect(norm(valueAt(s, constructorInputs(art), leaf)), `${s.id} ${leaf} (${from})`).toEqual(norm(want));
        if (fixture !== undefined) expect(norm(fixture), `${s.id} ${leaf}: DefaultParams' launch value against Appendix B`).toEqual(norm(want));
        if (from.startsWith("Appendix B alone")) alone.push(`${s.id} ${leaf}`);
      }
    }
    // the rows those values have no second source for, pinned as the spec writes them (Task 43a review, M3): a note or
    // gloss that a later edit gives a competing amount then needs this test edited too
    expect(appendixB("adapter caps")).toBe("50 TAO each");
    expect(appendixB("Base adapter minSendAmount")).toBe("0.01 TAO (v3-launch's, below the 0.04 TAO minimum deposit; the founder, 2026-11-07)");
    expect(appendixB("launchChain")).toBe("8453");
    expect(appendixB("treasury")).toBe("`0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6`");
    // where DefaultParams sets no value, Appendix B alone is the source: these, and only these
    expect(alone).toEqual([
      "bitAdapter c.maxMessageValue",
      "bitAdapter c.treasury",
      "vault p.treasury",
      "vault p.launchChain",
      "baseAdapter c.maxMessageValue",
      "baseAdapter c.treasury",
      "baseAdapter minSendAmount_",
      "frontDoor p.treasury",
      "staker p.treasury",
      "staker p.route0.kind",
      "staker p.route0.buyPath",
      "staker p.route0.sellPath",
      "staker p.route0.active",
    ]);
    // the gas figures are the contracts' calibration's, and the settings carry them, with the measurement's record (Task
    // 65: toward Base 180,000 / 32,000, the T61a review's I-2)
    const { source, ...figures } = SETTINGS_V32_LAUNCH.gas as SettingsV32["gas"];
    expect(figures).toEqual({
      towardBittensor: { base: gas("GAS_BASE_TO_BITTENSOR"), perEntry: gas("GAS_PER_ENTRY_TO_BITTENSOR") },
      towardBase: { base: gas("GAS_BASE_TO_BASE"), perEntry: gas("GAS_PER_ENTRY_TO_BASE") },
    });
    expect(figures.towardBase).toEqual({ base: 180_000n, perEntry: 32_000n });
    expect(source).toMatch(/^Task 61a's fork measurement .* written in by Task 65/);
  });

  it("everyCreateEncodesAgainstTheBuild: each create's arguments ABI-encode against its constructor in contracts/out", () => {
    for (const s of plan.steps) {
      const ins = constructorInputs(artifact(nameOf(s)));
      expect(s.args).toHaveLength(ins.length);
      expect(() => encodeAbiParameters(ins, s.args as never)).not.toThrow();
    }
  });

  it("standbyNeverInAConstructor: the vault stakes with the primary; the standby is only recorded", () => {
    const seen = (x: unknown): boolean =>
      typeof x === "string" ? same(x, YUMA) : Array.isArray(x) ? x.some(seen) : x !== null && typeof x === "object" ? Object.values(x).some(seen) : false;
    expect(plan.steps.some((s) => seen(s.args))).toBe(false);
    expect(plan.validators).toEqual({ primary: TAO_BOT, standby: YUMA });
    expect((step("vault").args[0] as { hotkey: Hex }).hotkey).toBe(TAO_BOT);
  });

  it("capRelationsRefused: the adapters' caps across the pair, the send minimum, the lane's limit and GAS_CAP", () => {
    const s = SETTINGS_V32_LAUNCH;
    expect(capRelationProblemsV32(s)).toEqual([]);
    const caps = (base: bigint, bittensor: bigint) => ({ ...s, adapters: { ...s.adapters, maxMessageValue: { base, bittensor } } });
    const TAO = 10n ** 18n;
    // adapterBase.maxMessageValue >= frontDoor.maxBatchValue
    expect(capRelationProblemsV32(caps(10n * TAO - 1n, 50n * TAO)).join("\n")).toMatch(/Base CcipBaseAdapter.maxMessageValue .* below the front door's maxBatchValue/);
    expect(capRelationProblemsV32(caps(10n * TAO, 50n * TAO))).toEqual([]);
    // adapterBit.maxMessageValue >= vault.maxMessageValue (15), vault.maxEntryValue (10), frontDoor.maxBatchValue (10)
    expect(capRelationProblemsV32(caps(50n * TAO, 15n * TAO - 1n)).join("\n")).toMatch(/Bittensor CcipBittensorAdapter.maxMessageValue .* below the vault's maxMessageValue/);
    expect(capRelationProblemsV32(caps(50n * TAO, 15n * TAO))).toEqual([]);
    const bigBatch = { ...caps(50n * TAO, 15n * TAO), frontDoor: { ...s.frontDoor, maxBatchValue: 20n * TAO } };
    expect(capRelationProblemsV32(bigBatch).join("\n")).toMatch(/Bittensor CcipBittensorAdapter.maxMessageValue .* below the front door's maxBatchValue/);
    const bigEntry = { ...caps(50n * TAO, 12n * TAO), vault: { ...s.vault, maxEntryValue: 13n * TAO, maxMessageValue: 12n * TAO } };
    expect(capRelationProblemsV32(bigEntry).join("\n")).toMatch(/below the vault's maxEntryValue/);
    // the Base adapter's minSendAmount within its cap
    expect(capRelationProblemsV32({ ...s, adapters: { ...s.adapters, minSendAmount: 50n * TAO + 1n } }).join("\n")).toMatch(/minSendAmount .* above its maxMessageValue/);
    // the lane's 5,000 TAO, and no zero cap
    expect(capRelationProblemsV32(caps(5_001n * TAO, 50n * TAO)).join("\n")).toMatch(/at most the lane's 5000 TAO/);
    // a gas model above GAS_CAP at 2 x MAX_ENTRIES entries (the adapter's constructor refuses it)
    const heavy = { ...s, gas: { ...s.gas, towardBittensor: { base: 780_000n, perEntry: 62_201n } } };
    expect(capRelationProblemsV32(heavy).join("\n")).toMatch(/toward Bittensor .* GAS_CAP/);
    expect(capRelationProblemsV32({ ...s, gas: { ...s.gas, towardBittensor: { base: 780_000n, perEntry: 62_200n } } })).toEqual([]);
  });

  it("validatorsFromConfig: SS58 or hex, the same bytes32; malformed, missing or equal hotkeys refused; Yuma's SS58", () => {
    expect(parseHotkey("x", TAO_BOT_SS58)).toBe(TAO_BOT);
    expect(parseHotkey("x", TAO_BOT.toUpperCase().replace("0X", "0x"))).toBe(TAO_BOT);
    expect(parseHotkey("x", YUMA_SS58)).toBe("0x40c47b6a294686fe9612b5d78dd369f4c77fa3bbf96a4286ede97410ba2e3209");
    expect(validatorsFromEnv({ OPS_V32_PRIMARY_HOTKEY: TAO_BOT_SS58, OPS_V32_STANDBY_HOTKEY: YUMA })).toEqual({ primary: TAO_BOT, standby: YUMA });
    expect(validatorsFromEnv({ OPS_V32_PRIMARY_HOTKEY: TAO_BOT, OPS_V32_STANDBY_HOTKEY: YUMA_SS58 })).toEqual({ primary: TAO_BOT, standby: YUMA });
    const refused = (primary: string | undefined, standby: string | undefined, why: RegExp) =>
      expect(() => validatorsFromEnv({ OPS_V32_PRIMARY_HOTKEY: primary, OPS_V32_STANDBY_HOTKEY: standby })).toThrow(why);
    refused(undefined, YUMA, /OPS_V32_PRIMARY_HOTKEY is not set/);
    refused(TAO_BOT, "", /OPS_V32_STANDBY_HOTKEY is not set/);
    refused(`${TAO_BOT_SS58.slice(0, -1)}v`, YUMA, /checksum/);
    refused("0x1234", YUMA, /not 32 bytes of hex/);
    refused(`0x${"zz".repeat(32)}`, YUMA, /not 32 bytes of hex/);
    refused(`0x${"00".repeat(32)}`, YUMA, /zero hotkey/);
    refused("not-an-address", YUMA, /not an SS58 address or 32 bytes of hex/);
    // the same validator twice, once as SS58 and once as hex
    refused(TAO_BOT_SS58, TAO_BOT, /the primary and the standby are the same hotkey/);
    expect(() => buildPlanV32(inputs({ validators: { primary: YUMA, standby: YUMA } }))).toThrow(/the same hotkey/);
  });

  it("rolesRefused: a guardian equal to the owner, a keeper equal to either or the treasury, the test wallet, a wrong treasury", () => {
    const refused = (roles: Partial<V32Roles>, why: RegExp) => expect(() => buildPlanV32(inputs({ roles: { ...ROLES, ...roles } }))).toThrow(why);
    refused({ guardian: ROLES.owner }, /the guardian .* is also the owner/);
    refused({ keeper: ROLES.owner }, /the keeper .* is also the owner/);
    refused({ keeper: ROLES.guardian }, /the keeper .* is also the guardian/);
    refused({ keeper: ROLES.treasury }, /the keeper .* is also the treasury/);
    refused({ keeper: V3_LAUNCH_KEEPER }, /the keeper .* is v3-launch's live keeper: v3.2's keeper is a fresh key/);
    for (const r of ["owner", "guardian", "keeper"] as const) refused({ [r]: WALLET }, new RegExp(`the ${r} is the test wallet`));
    refused({ treasury: WALLET }, /the treasury is the test wallet/);
    refused({ treasury: at("d0d1") }, /is not Appendix B's 0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6/);
    refused({ owner: at("0") }, /the owner is the zero address/);
    // a deployer is a fresh single-use key: one per chain, no role's, never the test wallet
    const deployers = (d: Partial<typeof DEPLOYERS>, why: RegExp) => expect(() => buildPlanV32(inputs({ deployers: { ...DEPLOYERS, ...d } }))).toThrow(why);
    deployers({ base: DEPLOYERS.bittensor }, /each chain needs its own fresh key/);
    deployers({ bittensor: WALLET }, /the Bittensor deployer is the test wallet/);
    deployers({ base: ROLES.owner }, /the Base deployer is also the owner/);
    deployers({ base: ROLES.treasury }, /the Base deployer is also the treasury/);
    // every problem is named at once, and nothing is planned
    expect(() => buildPlanV32(inputs({ roles: { ...ROLES, guardian: ROLES.owner, keeper: ROLES.owner } }))).toThrow(/guardian[\s\S]*keeper[\s\S]*nothing planned/);
  });

  it("inputsWithinTheContractsBounds: claimGasRequired and the pool floors; the bounds are the contracts' own", () => {
    expect(BOUNDS_V32.maxEntries).toBe(Number(solConstant("contracts/src/libraries/CascadeMessages.sol", "MAX_ENTRIES")));
    expect(BOUNDS_V32.gasCap).toBe(solConstant("contracts/src/adapters/CcipAdapterBase.sol", "GAS_CAP"));
    expect(BOUNDS_V32.maxMessageValue).toBe(solConstant("contracts/src/adapters/CcipAdapterBase.sol", "MAX_MESSAGE_VALUE"));
    expect(BOUNDS_V32.minClaimGas).toBe(solConstant("contracts/src/CascadeConstants.sol", "MIN_CLAIM_GAS"));
    expect(BOUNDS_V32.maxClaimGas).toBe(solConstant("contracts/src/CascadeConstants.sol", "MAX_CLAIM_GAS"));
    // R7: set-caps refuses a minimum deposit above it, as the contracts round's setCaps does
    expect(BOUNDS_V32.maxBatchValue).toBe(solConstant("contracts/src/CascadeFrontDoor.sol", "MAX_BATCH_VALUE"));
    // batch limits within MAX_ENTRIES a side
    expect(SETTINGS_V32_LAUNCH.frontDoor.maxDeposits).toBeLessThanOrEqual(BOUNDS_V32.maxEntries);
    expect(SETTINGS_V32_LAUNCH.frontDoor.maxRedeems).toBeLessThanOrEqual(BOUNDS_V32.maxEntries);
    expect(buildPlanV32(inputs({ claimGasRequired: BOUNDS_V32.minClaimGas })).claimGasRequired).toBe(BOUNDS_V32.minClaimGas);
    expect(buildPlanV32(inputs({ claimGasRequired: BOUNDS_V32.maxClaimGas })).claimGasRequired).toBe(BOUNDS_V32.maxClaimGas);
    expect(() => buildPlanV32(inputs({ claimGasRequired: BOUNDS_V32.minClaimGas - 1n }))).toThrow(/claimGasRequired .* outside/);
    expect(() => buildPlanV32(inputs({ claimGasRequired: BOUNDS_V32.maxClaimGas + 1n }))).toThrow(/claimGasRequired .* outside/);
    expect(() => buildPlanV32(inputs({ poolFloors: [0n, FLOORS[1]] }))).toThrow(/TAO\/WETH pool floor 0/);
    expect(() => buildPlanV32(inputs({ poolFloors: [FLOORS[0], 1n << 128n] }))).toThrow(/WETH\/USDC pool floor/);
  });

  it("blockTimeInMilliseconds: each scheduler's msPerBlock is its chain's pin (7,200 and 120 ms, Revision 28); a value in seconds is refused", () => {
    expect(MS_PER_BLOCK_PINS).toEqual({ bittensor: 7_200n, base: 120n });
    // CascadeBase._halfInBlocks: ceil(secs * 1000 / (2 * ms)), rounded up as the contract rounds
    expect(halfInBlocks(172_800, 120n)).toBe(720_000);
    expect(halfInBlocks(604_800, 7_200n)).toBe(42_000);
    expect(halfInBlocks(14_401, 7_200)).toBe(1_001);
    expect(halfInBlocks(1, 7_200)).toBe(1);
    expect(halfInBlocks(0, 120)).toBe(0);
    expect(SETTINGS_V32_LAUNCH.vault.msPerBlock).toBe(MS_PER_BLOCK_PINS.bittensor);
    expect(SETTINGS_V32_LAUNCH.frontDoor.msPerBlock).toBe(MS_PER_BLOCK_PINS.base);
    expect(msPerBlockProblems(SETTINGS_V32_LAUNCH)).toEqual([]);
    // the old seconds (12 and 2) the constructor would take as 12 and 2 ms: refused, naming each
    expect(msPerBlockProblems({ vault: { msPerBlock: 12n }, frontDoor: { msPerBlock: 2n } })).toEqual([
      "the vault's msPerBlock is 12, not Bittensor's pin of 7200 ms (MS_PER_BLOCK_PINS): it is milliseconds (Revision 28), and 12 would be taken as 12 ms",
      "the front door's msPerBlock is 2, not Base's pin of 120 ms (MS_PER_BLOCK_PINS): it is milliseconds (Revision 28), and 2 would be taken as 2 ms",
    ]);
    expect(msPerBlockProblems({ vault: { msPerBlock: 7_200n }, frontDoor: { msPerBlock: 200n } })).toEqual([
      "the front door's msPerBlock is 200, not Base's pin of 120 ms (MS_PER_BLOCK_PINS): it is milliseconds (Revision 28), and 200 would be taken as 200 ms",
    ]);
    // the plan carries the pins into both constructors
    expect((step("vault").args[0] as { msPerBlock: bigint }).msPerBlock).toBe(7_200n);
    expect((step("frontDoor").args[0] as { msPerBlock: bigint }).msPerBlock).toBe(120n);
    // settings with a seconds value: nothing planned
    const v = SETTINGS_V32_LAUNCH.vault as { msPerBlock: bigint };
    v.msPerBlock = 12n;
    try {
      expect(() => buildPlanV32(inputs())).toThrow(/the vault's msPerBlock is 12, not Bittensor's pin of 7200 ms[\s\S]*nothing planned/);
    } finally {
      v.msPerBlock = 7_200n;
    }
  });

  it("capsWarningAboveTheFounderLevel: warns, quoting section 5, unless the owner is a 2-of-3 Safe; never at the launch's caps", () => {
    // the quoted residual is the spec's own words
    for (const q of SINGLE_KEY_RESIDUAL) expect(specText().replace(/\s*\n\s*/g, " ")).toContain(q);
    const account = { kind: "account" } as const;
    expect(FOUNDER_LEVEL).toEqual({ depositCap: abTao("deposit cap"), maxTotalAssets: abTao("maxTotalAssets") });
    expect(capsWarning({ depositCap: FOUNDER_LEVEL.depositCap, maxTotalAssets: FOUNDER_LEVEL.maxTotalAssets }, account)).toBeNull();
    const above = { depositCap: FOUNDER_LEVEL.depositCap + 1n };
    expect(capsWarning(above, account)).toMatch(/WARNING: a deposit cap of 40.000000000000000001 TAO .* a plain account[\s\S]*Until the Safe, one Ledger owns every contract[\s\S]*nothing is refused/);
    expect(capsWarning({ maxTotalAssets: FOUNDER_LEVEL.maxTotalAssets + 1n }, account)).toMatch(/maxTotalAssets of 44.000000000000000001 TAO/);
    // an EIP-7702 delegated account counts as an account
    expect(capsWarning(above, { kind: "account", delegation: at("7702") })).toMatch(/delegated to .* \(it counts as an account\)/);
    expect(capsWarning(above, { kind: "safe", threshold: 1n, owners: 3 })).toMatch(/a Safe with a threshold of 1 and 3 signers/);
    expect(capsWarning(above, { kind: "safe", threshold: 2n, owners: 2 })).toMatch(/WARNING/);
    expect(capsWarning(above, { kind: "timelock" })).toMatch(/a timelock/);
    expect(capsWarning(above, { kind: "safe", threshold: 2n, owners: 3 })).toBeNull();
  });

  it("keeperFromThePlansInputs: OPS_V32_KEEPER_ADDRESS, a fresh key, never v3-launch's keeper, a role's or the test wallet; no default", () => {
    // the plan's Keys line: the v3.2 keeper is a fresh key from OPS_V32_KEEPER_ADDRESS, never v3-launch's live keeper,
    // which it names (the founder's 2026-11-07 decision); and Task 43's inputs list it
    const text = readFileSync(new URL("../../docs/superpowers/plans/2026-11-01-cascade-v3.2-implementation.md", import.meta.url), "utf8");
    const keys = text.split("\n").find((l) => l.startsWith("- Keys (founder decisions):"))!;
    expect(keys).toContain("keeper: a fresh key of its own, its address from `OPS_V32_KEEPER_ADDRESS` (no default)");
    expect(keys.match(/never v3-launch's live keeper `(0x[0-9a-fA-F]{40})`/)![1]).toBe(V3_LAUNCH_KEEPER);
    expect(keys.match(/0x[0-9a-fA-F]{40}/g)).toEqual([ROLES_V32_LAUNCH.owner, ROLES_V32_LAUNCH.guardian, V3_LAUNCH_KEEPER, ROLES_V32_LAUNCH.treasury]);
    const inputs = text.split("\n").find((l) => l.includes("Inputs come from env: `OPS_V32_DEPLOYER_"))!;
    expect(inputs).toContain("`OPS_V32_KEEPER_ADDRESS` (the v3.2 keeper's address, a fresh key; no default)");
    // the launch's fixed roles name no keeper: it comes from the plan's inputs only
    expect(Object.keys(ROLES_V32_LAUNCH).sort()).toEqual(["guardian", "owner", "treasury"]);
    const fresh = getAddress(`0x${"c0ffee".repeat(6)}c0ff`);
    // every letter's case flipped: mixed case, so a checksum that is wrong
    const badChecksum = `0x${[...fresh.slice(2)].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("")}`;
    expect(badChecksum).not.toBe(badChecksum.toLowerCase());
    expect(badChecksum).not.toBe(badChecksum.toUpperCase().replace("0X", "0x"));
    expect(keeperFromEnv({ OPS_V32_KEEPER_ADDRESS: ` ${fresh} ` })).toBe(fresh);
    expect(keeperFromEnv({ OPS_V32_KEEPER_ADDRESS: fresh.toLowerCase() })).toBe(fresh);
    expect(rolesV32FromEnv({ OPS_V32_KEEPER_ADDRESS: fresh })).toEqual({ ...ROLES_V32_LAUNCH, keeper: fresh });
    const refused = (value: string | undefined, why: RegExp) => {
      const env = value === undefined ? {} : { OPS_V32_KEEPER_ADDRESS: value };
      expect(() => keeperFromEnv(env)).toThrow(why);
      expect(() => rolesV32FromEnv(env)).toThrow(/the v3.2 keeper is not ready:[\s\S]*nothing read or sent/);
    };
    refused(undefined, /OPS_V32_KEEPER_ADDRESS is not set: the v3.2 keeper is a fresh key, and there is no default/);
    refused("  ", /OPS_V32_KEEPER_ADDRESS is not set/);
    refused("0x1234", /OPS_V32_KEEPER_ADDRESS "0x1234" is not an address/);
    refused(badChecksum, /is not an address \(or its checksum is wrong\)/);
    refused(`0x${"0".repeat(40)}`, /the keeper is the zero address/);
    refused(V3_LAUNCH_KEEPER, /is v3-launch's live keeper/);
    refused(V3_LAUNCH_KEEPER.toLowerCase(), /is v3-launch's live keeper/);
    refused(ROLES_V32_LAUNCH.owner, /the keeper .* is also the owner/);
    refused(ROLES_V32_LAUNCH.guardian, /the keeper .* is also the guardian/);
    refused(ROLES_V32_LAUNCH.treasury, /the keeper .* is also the treasury/);
    refused(WALLET, /the keeper is the test wallet/);
  });

  it("deployerKeysFromEnv: paths only, one fresh key per chain, never the test wallet's keystore, nothing opened", () => {
    const env = {
      OPS_V32_DEPLOYER_BASE_KEYSTORE: "Z:/no/such/base-keystore",
      OPS_V32_DEPLOYER_BASE_PASSWORD_FILE: "Z:/no/such/base.pw",
      OPS_V32_DEPLOYER_BITTENSOR_KEYSTORE: "Z:/no/such/bit-keystore",
      OPS_V32_DEPLOYER_BITTENSOR_PASSWORD_FILE: "Z:/no/such/bit.pw",
      OPS_KEYSTORE: "Z:/no/such/test-wallet",
    };
    // files that do not exist pass: nothing is read
    expect(deployerKeysFromEnv(env)).toEqual({
      base: { keystore: "Z:/no/such/base-keystore", passwordFile: "Z:/no/such/base.pw" },
      bittensor: { keystore: "Z:/no/such/bit-keystore", passwordFile: "Z:/no/such/bit.pw" },
    });
    expect(() => deployerKeysFromEnv({ ...env, OPS_V32_DEPLOYER_BITTENSOR_PASSWORD_FILE: " " })).toThrow(/OPS_V32_DEPLOYER_BITTENSOR_PASSWORD_FILE is not set/);
    expect(() => deployerKeysFromEnv({ ...env, OPS_V32_DEPLOYER_BITTENSOR_KEYSTORE: "z:\\no\\such\\BASE-KEYSTORE" })).toThrow(/the same keystore/);
    expect(() => deployerKeysFromEnv({ ...env, OPS_V32_DEPLOYER_BASE_KEYSTORE: env.OPS_KEYSTORE })).toThrow(/the Base deployer is the test wallet's keystore/);
  });

  it("the plan names each contract's label", () => {
    expect(Object.keys(CONTRACTS_V32).sort()).toEqual([...NONCE_PLAN.bittensor, ...NONCE_PLAN.base].sort());
    expect(plan.steps.map((s) => s.label)).toEqual(plan.steps.map((s) => CONTRACTS_V32[s.id].label));
  });

  it("the address derivation against known creates: a textbook vector, and v3-launch's real creates (Task 45's re-review, N1)", () => {
    // the textbook CREATE vector (deployer 0x6ac7…dbf0 at nonces 0 to 3), through the plan's own derivation; the
    // expected addresses are literals, never viem's getContractAddress again
    const textbook = getAddress("0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0");
    const a = plannedAddressesV32({ bittensor: textbook, base: DEPLOYERS.base });
    expect([a.bitAdapter, a.payoutMath, a.stakeLib, a.payoutLib].map((x) => x.toLowerCase())).toEqual([
      "0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d",
      "0x343c43a37d37dff08ae8c4a11544c718abb4fcf8",
      "0xf778b86fa74e846c4f0a1fbd1335fe81c00a0c91",
      "0xfffd933a0bc612844eaf0c6fe3e5b8e9b6c1d19c",
    ]);
    // the same deployer on Base gives the same addresses at the same nonces
    expect(plannedAddressesV32({ bittensor: DEPLOYERS.bittensor, base: textbook }).baseAdapter.toLowerCase()).toBe("0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d");
    // v3-launch's real creates, as the chains made them: the test wallet's nonces 18 to 23, at the addresses
    // web/src/lib/cascade/deployments.json records for "v3-launch"
    const live = JSON.parse(readFileSync(join(paths({}).contractsDir, "..", "web", "src", "lib", "cascade", "deployments.json"), "utf8"))["v3-launch"] as Record<string, string>;
    const created: [number, string][] = [
      [18, "bitAdapter"],
      [19, "vault"],
      [20, "baseAdapter"],
      [21, "oracle"],
      [22, "frontDoor"],
      [23, "staker"],
    ];
    for (const [nonce, name] of created) expect(createAddressV32(WALLET, nonce), name).toBe(getAddress(live[name]));
    // and the plan's addresses are that derivation at each step's nonce
    for (const s of plan.steps) expect(plan.addresses[s.id], s.id).toBe(createAddressV32(plan.deployers[s.chain], s.nonce));
  });
});
