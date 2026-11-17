import { type AbiFunction, type Address, getAddress, type Hex, numberToHex, parseAbi, parseEther } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE_V3, paths } from "../src/config.ts";
import { decodeDeployment, type DeploymentV32, encodeDeployment } from "../src/keeper/core/deployment.ts";
import { classifyFailure, KeeperNotReady } from "../src/keeper/core/failures.ts";
import { freshMemory } from "../src/keeper/core/memory.ts";
import { runRound } from "../src/keeper/core/round.ts";
import { targetV32 } from "../src/keeper/core/v32/actions.ts";
import { EXIT_GAS_RESERVE } from "../src/keeper/core/v32/payout.ts";
import {
  addressMapping,
  checkReadyV32,
  codeHashOf,
  everyRoundProblems,
  FOR_LIFE_EVERY_MS,
  forLifeProblems,
  stripMetadata,
} from "../src/keeper/core/v32/readiness.ts";
import { deploymentFromRecordV32, SPEND_CAP_DEFAULT, spendCapOf, vaultCreatedAtOf } from "../src/keeper/deployment-v32.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { type BuildV32, freezeBuildV32, type SourceV32 } from "../src/v32/build.ts";
import { domainSeparatorV32, expectedRuntimeV32 } from "../src/v32/code.ts";
import type { DeploymentRecordV32 } from "../src/v32/deploy.ts";
import { addressMapping as planAddressMapping, NONCE_PLAN } from "../src/v32/plan.ts";
import { STAMP_TYPEHASH_V32 } from "../src/v32/verify.ts";
import { planV32 } from "./v32-fixtures.ts";
import { ADDR, CREATED, deploymentFor, depsFor, KEY, T, TAO, type World, world } from "./keeper-v32-world.ts";

// The v3.2 keeper's readiness (design-keeper-worker.md §6, Task 46b's report §6): live, every round, what it must be
// to send at all; every hour, what holds for life; never the stored verify.ok. And the deployment it runs on, built
// from the record and the frozen build.

const SOURCE: SourceV32 = { commit: "c0ffee".padEnd(40, "0"), tree: "7ee".padEnd(40, "0"), dirty: [] };
const CHAIN_IDS = { base: 8453, bittensor: 964 };
let build: BuildV32;
beforeAll(async () => {
  build = (await freezeBuildV32(paths({}).contractsDir, SOURCE)).build;
});

const OPTS = { intervalMs: 60_000, policy: { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 }, rewardsEveryTicks: 1000 };

/** The record a deploy leaves: every create done (each with its block), and a later verify that FAILED (an owner moved
 * the vault to a Safe, say): the keeper never reads it. */
function record(): DeploymentRecordV32 {
  const plan = planV32();
  const sent = (block: number) => ({ hash: `0x${"11".repeat(32)}` as Hex, block, gasUsed: 1n, costWei: 1n });
  return {
    target: "live",
    createdAt: "",
    plan,
    build: { dir: "v32-test", hash: `0x${"00".repeat(32)}` },
    done: Object.fromEntries(plan.steps.map((s) => [s.id, sent(s.chain === "base" ? 30_000_000 : 6_000_000)])),
    verify: { ok: false, failures: ["Bittensor CascadeVault owner() is the Safe, not the plan's owner"], checkedAt: "" },
  };
}

/** The deployment the record builds, the vault created at CREATED. */
const fromRecord = (rec: DeploymentRecordV32 = record(), over: Partial<Parameters<typeof deploymentFromRecordV32>[1]> = {}) =>
  deploymentFromRecordV32(rec, { name: "v3.2-launch", chainIds: CHAIN_IDS, env: {}, build, web: null, vaultCreatedAt: CREATED, ...over });

/** The slot0 a pool answers, with `cardinality` observation slots in use. */
const slot0 = (cardinality: number) => [2n ** 96n, 0, 0, cardinality, cardinality, 0, true];

/** A world that answers every for-life getter as the deployment says it must, with every contract's code the frozen
 * build's, each pool its planned fee and 1,801 observation slots (the oracle's MIN_CARDINALITY, TWAP_WINDOW + 1, as its code
 * answers), and
 * the vault's last stake since its creation. */
function healthy(dep: DeploymentV32): World {
  const w = world();
  for (const v of dep.forLife.values) {
    const want = v.returns === "address" || v.returns === "bytes32" ? v.want : v.returns === "bool" ? v.want === "true" : BigInt(v.want);
    w.answers[`${v.address.toLowerCase()}:${v.fn}`] = () => want;
    w.fns.push(...(parseAbi([`function ${v.fn}() view returns (${v.returns})`]) as unknown as AbiFunction[]));
  }
  for (const p of dep.forLife.pools) {
    w.answers[`${p.address.toLowerCase()}:fee`] = () => p.fee;
    w.answers[`${p.address.toLowerCase()}:slot0`] = () => slot0(1_801);
  }
  w.answers[`${dep.addresses.oracle.toLowerCase()}:MIN_CARDINALITY`] = () => 1_801;
  w.answers[`${dep.addresses.vaultLens.toLowerCase()}:lastStakeAt`] = () => BigInt(CREATED + 86_400);
  // the Bittensor adapter's parks: none
  w.answers[`${dep.addresses.bitAdapter.toLowerCase()}:parkedNative`] = () => 0n;
  w.answers[`${dep.addresses.bitAdapter.toLowerCase()}:parkedTokens`] = () => 0n;
  return w;
}

/** The record's deployment in a healthy world, every contract's code the frozen build's. */
function healthyFromRecord(dep: DeploymentV32 = fromRecord()): World {
  const w = healthy(dep);
  for (const c of dep.forLife.code) {
    const id = [...NONCE_PLAN.bittensor, ...NONCE_PLAN.base].find((x) => getAddress(record().plan.addresses[x]) === c.address)!;
    w.codes[c.address.toLowerCase()] = expectedRuntimeV32(build, record().plan, id, CHAIN_IDS);
  }
  return w;
}

describe("the deployment the v3.2 keeper runs on, from the record (never verify.ok)", () => {
  it("built from the plan and the frozen build, whatever the last verify said; the Worker's DEPLOYMENT var reads back the same", () => {
    const rec = record();
    const dep = fromRecord(rec);
    const a = rec.plan.addresses;
    expect(dep).toMatchObject({ version: "v3.2", name: "v3.2-launch", keeper: getAddress(rec.plan.roles.keeper), batchMaxWaitS: 86_400, usdcDelivery: true, payoutTopUpMax: 0n, launchChain: 8453n });
    // the vault's coldkey and creation time; the oracle's pools with route 0's fee tiers (USDC -500-> WETH -3000-> TAO)
    expect([dep.vaultColdkey, dep.vaultCreatedAt]).toEqual([rec.plan.vaultColdkey, CREATED]);
    expect(dep.forLife.pools).toEqual([
      { pair: "WETH/USDC", address: getAddress(BASE_V3.WETH_USDC_POOL), fee: 500 },
      { pair: "TAO/WETH", address: getAddress(BASE_V3.TAO_WETH_POOL), fee: 3000 },
    ]);
    expect(() => decodeDeployment(encodeDeployment({ ...dep, vaultCreatedAt: 0 }))).toThrow(/its vault creation time is not a time/);
    expect(() => decodeDeployment(encodeDeployment({ ...dep, forLife: { ...dep.forLife, pools: [{ pair: "TAO/WETH", address: "0x12" as Address, fee: 3000 }] } }))).toThrow(/its TAO\/WETH pool is not an address/);
    expect(() => decodeDeployment(encodeDeployment({ ...dep, vaultColdkey: "0x12" }))).toThrow(/its vault coldkey is not a 32-byte word/);
    expect(dep.startBlocks).toEqual({ bittensor: 6_000_000n, base: 30_000_000n });
    const value = (contract: string, fn: string) => dep.forLife.values.find((v) => v.contract === contract && v.fn === fn);
    expect(value("CascadeFrontDoor", "vault")).toMatchObject({ chain: "base", address: getAddress(a.frontDoor), returns: "address", want: a.vault });
    expect(value("CascadeVault", "launchChain")).toMatchObject({ chain: "bittensor", address: getAddress(a.vault), want: "8453" });
    expect(value("CascadeVault", "MS_PER_BLOCK")).toMatchObject({ want: "7200" });
    expect(value("CascadeFrontDoor", "MS_PER_BLOCK")).toMatchObject({ want: "120" });
    // the vault's stamp domain is read through its lens; the door's through its own
    expect(value("CascadeVaultLens", "DOMAIN_SEPARATOR")).toMatchObject({ address: getAddress(a.vaultLens), want: domainSeparatorV32(964, a.vault) });
    expect(value("CascadeDoorLens", "DOMAIN_SEPARATOR")).toMatchObject({ address: getAddress(a.doorLens), want: domainSeparatorV32(8453, a.frontDoor) });
    expect(value("CascadeVaultLens", "STAMP_TYPEHASH")?.want).toBe(STAMP_TYPEHASH_V32);
    // merge 7b (R4): the lane's inbound gas model, one setting in two copies, each the plan's for life: the Bittensor
    // adapter's inbound pair (deliverParked's requirement) and the Base adapter's own pair (what CCIP gives a delivery)
    const bitArgs = rec.plan.steps.find((s) => s.id === "bitAdapter")!.args;
    const baseCfg = rec.plan.steps.find((s) => s.id === "baseAdapter")!.args[0] as { gasBase: bigint; gasPerEntry: bigint };
    expect([bitArgs[2], bitArgs[3]]).toEqual([baseCfg.gasBase, baseCfg.gasPerEntry]);
    expect(value("CcipBittensorAdapter", "inboundGasBase")).toMatchObject({ chain: "bittensor", address: getAddress(a.bitAdapter), returns: "uint256", want: String(bitArgs[2]) });
    expect(value("CcipBittensorAdapter", "inboundGasPerEntry")).toMatchObject({ chain: "bittensor", address: getAddress(a.bitAdapter), returns: "uint256", want: String(bitArgs[3]) });
    expect(value("CcipBaseAdapter", "gasBase")).toMatchObject({ chain: "base", address: getAddress(a.baseAdapter), returns: "uint256", want: String(baseCfg.gasBase) });
    expect(value("CcipBaseAdapter", "gasPerEntry")).toMatchObject({ chain: "base", address: getAddress(a.baseAdapter), returns: "uint256", want: String(baseCfg.gasPerEntry) });
    // the code of every create of the nonce plan (13), by its hash without the metadata
    expect(dep.forLife.code.map((c) => c.contract)).toHaveLength(NONCE_PLAN.bittensor.length + NONCE_PLAN.base.length);
    for (const c of dep.forLife.code) {
      const id = [...NONCE_PLAN.bittensor, ...NONCE_PLAN.base].find((x) => getAddress(rec.plan.addresses[x]) === c.address);
      expect(c.codeHash, c.contract).toBe(codeHashOf(expectedRuntimeV32(build, rec.plan, id!, CHAIN_IDS)));
    }
    expect(decodeDeployment(encodeDeployment(dep))).toEqual(dep);
    expect(() => decodeDeployment(encodeDeployment({ ...dep, payoutTopUpMax: 1n }))).toThrow(/top-up limit is not a whole number of rao/);
    expect(() => decodeDeployment(encodeDeployment({ ...dep, batchMaxWaitS: 0 }))).toThrow(/batch max wait/);
    // a record with no creation block is refused (where the log scans start)
    const noBlock = { ...rec, done: { ...rec.done, bitAdapter: undefined } } as unknown as DeploymentRecordV32;
    expect(() => fromRecord(noBlock)).toThrow(/no block for the Bittensor adapter's creation/);
    // the web's entry decides the max wait and the delivery flag
    expect(fromRecord(rec, { web: { batchMaxWaitS: 43_200, usdcDelivery: false } })).toMatchObject({ batchMaxWaitS: 43_200, usdcDelivery: false });
  });

  it("the 24 h spend cap per chain (Task 50a; R12a): Base's holds a day's closes, a full batch's twice over; vars that change without code", () => {
    // Base (R12a, the ChatGPT r3 DoS scan's item 6: 0.0017 ETH was less than one full-list close, about 0.002, so one
    // forced close stopped every Base send for up to 24 hours): 0.01 ETH, about two full 50 + 50 closes (about 0.0043 ETH
    // each, gas and fee) or a dozen one-entry closes (about 0.00075). Bittensor (the founder, 2026-11-08, Task 51 fix round
    // 1): about 0.4 TAO funded and a 0.4 TAO cap (the controller's ruling, Task 51 fix round 2), one claim's worst case up
    // front plus a day of payouts and stakes up to about 5.5 gwei (Task 65: the 2,000,000 reserve)
    expect(fromRecord().spendCap).toEqual({ base: parseEther("0.01"), bittensor: parseEther("0.4") });
    expect(SPEND_CAP_DEFAULT).toEqual({ base: parseEther("0.01"), bittensor: parseEther("0.4") });
    const env = { OPS_KEEPER_SPEND_CAP_BASE: "0.002", OPS_KEEPER_SPEND_CAP_BITTENSOR: "0.05" };
    expect(fromRecord(record(), { env }).spendCap).toEqual({ base: parseEther("0.002"), bittensor: parseEther("0.05") });
    expect(spendCapOf({ OPS_KEEPER_SPEND_CAP_BASE: "" })).toEqual(SPEND_CAP_DEFAULT);
    for (const bad of ["0", "-1", "one", "1e-3"]) {
      expect(() => spendCapOf({ OPS_KEEPER_SPEND_CAP_BASE: bad }), bad).toThrow(/OPS_KEEPER_SPEND_CAP_BASE .* is not an amount of ETH above 0/);
    }
    expect(() => spendCapOf({ OPS_KEEPER_SPEND_CAP_BITTENSOR: "0" })).toThrow(/OPS_KEEPER_SPEND_CAP_BITTENSOR .* is not an amount of TAO above 0/);
    const dep = fromRecord();
    expect(() => decodeDeployment(encodeDeployment({ ...dep, spendCap: { base: 0n, bittensor: 1n } }))).toThrow(/its Base spend cap is not an amount of wei above 0/);
    expect(() => decodeDeployment(encodeDeployment({ ...dep, spendCap: undefined as never }))).toThrow(/its Base spend cap/);
  });

  it("Task 52: each lane's OnRamp and selectors (the live ones), and OPS_PARK_REFUND_FEE_MAX when set (else the core's cap)", () => {
    const dep = fromRecord();
    expect([dep.onRamps, dep.selectors]).toEqual([
      { base: "0xF75bf16b03aaE98677926F0987F195A2153996B9", bittensor: "0x5aA05e14ac7FaF23F1757d46429E6CA7e3FC1274" },
      { base: 15971525489660198786n, bittensor: 2135107236357186872n },
    ]);
    expect(dep.parkRefundFeeMax).toBeUndefined();
    expect(fromRecord(record(), { env: { OPS_PARK_REFUND_FEE_MAX: "0.08" } }).parkRefundFeeMax).toBe(parseEther("0.08"));
    for (const bad of ["0", "-1", "one"]) expect(() => fromRecord(record(), { env: { OPS_PARK_REFUND_FEE_MAX: bad } }), bad).toThrow(/OPS_PARK_REFUND_FEE_MAX .* is not an amount of TAO above 0/);
    expect(decodeDeployment(encodeDeployment(dep))).toEqual(dep);
    expect(() => decodeDeployment(encodeDeployment({ ...dep, selectors: undefined }))).toThrow(/OnRamps without selectors/);
    expect(() => decodeDeployment(encodeDeployment({ ...dep, onRamps: { ...dep.onRamps!, base: "0x12" as Address } }))).toThrow(/its base OnRamp is not an address/);
    expect(() => decodeDeployment(encodeDeployment({ ...dep, parkRefundFeeMax: 0n }))).toThrow(/park refund fee cap/);
  });

  it("Task 52 fix round 1: automatic re-execution is off unless OPS_REEXEC_AUTO=on (the founder's ruling), read and checked like the refund's cap", () => {
    expect(fromRecord().reexecAuto).toBeUndefined();
    expect(fromRecord(record(), { env: { OPS_REEXEC_AUTO: "" } }).reexecAuto).toBeUndefined();
    expect(fromRecord(record(), { env: { OPS_REEXEC_AUTO: "on" } }).reexecAuto).toBe(true);
    expect(fromRecord(record(), { env: { OPS_REEXEC_AUTO: " OFF " } }).reexecAuto).toBe(false);
    for (const bad of ["yes", "1", "true", "auto"]) expect(() => fromRecord(record(), { env: { OPS_REEXEC_AUTO: bad } }), bad).toThrow(new RegExp(`OPS_REEXEC_AUTO "${bad}" is not on or off; nothing sent`));
    const dep = fromRecord(record(), { env: { OPS_REEXEC_AUTO: "on" } });
    expect(decodeDeployment(encodeDeployment(dep))).toEqual(dep);
    expect(() => decodeDeployment(encodeDeployment({ ...dep, reexecAuto: "on" as never }))).toThrow(/its automatic re-execution setting is not true or false/);
  });

  it("the vault's creation time is its create's block time on Bittensor, read once when the deployment is built", async () => {
    const asked: unknown[][] = [];
    const rpc = (block: { timestamp: Hex } | null): Rpc => ({
      async request(chain, method, params) {
        asked.push([chain, method, ...params]);
        return block;
      },
    });
    expect(await vaultCreatedAtOf(rpc({ timestamp: numberToHex(CREATED) }), record())).toBe(CREATED);
    expect(asked).toEqual([["bittensor", "eth_getBlockByNumber", numberToHex(6_000_000), false]]);
    await expect(vaultCreatedAtOf(rpc(null), record())).rejects.toThrow(/Bittensor has no block 6000000 \(the vault's creation\): use an RPC that keeps history \(archive\.chain\.opentensor\.ai\); nothing built/);
    const noVault = { ...record(), done: { ...record().done, vault: undefined } } as unknown as DeploymentRecordV32;
    await expect(vaultCreatedAtOf(rpc({ timestamp: "0x1" }), noVault)).rejects.toThrow(/the record has no block for the vault's creation/);
  });
});

describe("readiness: live, every round; for life, every hour; never verify.ok", () => {
  it("every round: keeper() names the key on both contracts (R4, D-M1: whatever the deployment's keeper, the plan's first); each RPC is on its chain", async () => {
    const w = world();
    expect(await everyRoundProblems(depsFor(w).deps)).toEqual([]);
    const rotated = world();
    rotated.vault.keeper = getAddress(`0x${"99".repeat(20)}`);
    rotated.door.keeper = getAddress(`0x${"98".repeat(20)}`);
    expect(await everyRoundProblems(depsFor(rotated).deps)).toEqual([
      expect.stringMatching(/^the vault's keeper\(\) is 0x9999.*, not the keeper's key/),
      expect.stringMatching(/^the front door's keeper\(\) is 0x9898.*, not the keeper's key/),
    ]);
    const wrongChain = world();
    wrongChain.chainIds.base = 1;
    expect(await everyRoundProblems(depsFor(wrongChain).deps)).toEqual(["the Base RPC reports chain id 1, not 8453"]);
    // a deployment naming another keeper (the plan's first, after a rotation) is no problem while keeper() names the key
    const otherKey = depsFor(world(), freshMemory(), deploymentFor({ keeper: getAddress(`0x${"77".repeat(20)}`) })).deps;
    expect(await everyRoundProblems(otherKey)).toEqual([]);
  });

  it("for life: every immutable and constant as planned, every contract's code the frozen build's, the adapter holding its parks", async () => {
    const dep = fromRecord();
    const w = healthyFromRecord(dep);
    const deps = () => depsFor(w, freshMemory(), dep).deps;
    expect(await forLifeProblems(deps())).toEqual([]);
    // an immutable that is not the plan's (a door bound to another vault)
    const door = dep.forLife.values.find((v) => v.contract === "CascadeFrontDoor" && v.fn === "vault")!;
    w.answers[`${door.address.toLowerCase()}:vault`] = () => getAddress(`0x${"66".repeat(20)}`);
    expect(await forLifeProblems(deps())).toEqual([expect.stringMatching(/^Base CascadeFrontDoor's vault\(\) is 0x6666.*, not 0x/)]);
    w.answers[`${door.address.toLowerCase()}:vault`] = () => door.want;
    // code that is not the build's, and none at all
    const lens = dep.forLife.code.find((c) => c.contract === "CascadeVaultLens")!;
    const good = w.codes[lens.address.toLowerCase()];
    w.codes[lens.address.toLowerCase()] = `0x00${good.slice(4)}` as Hex;
    expect(await forLifeProblems(deps())).toEqual([`Bittensor CascadeVaultLens at ${lens.address}: its code is not the frozen build's`]);
    delete w.codes[lens.address.toLowerCase()];
    expect(await forLifeProblems(deps())).toEqual([`Bittensor CascadeVaultLens at ${lens.address}: no code`]);
    w.codes[lens.address.toLowerCase()] = good;
    // a metadata-only difference passes (the hash is over the code without its CBOR tail)
    expect(stripMetadata(good)).toBeDefined();
    // I-7: the Bittensor adapter holds less than its parks owe
    w.answers[`${dep.addresses.bitAdapter.toLowerCase()}:parkedNative`] = () => 2n * TAO;
    w.balances[dep.addresses.bitAdapter.toLowerCase()] = TAO;
    expect(await forLifeProblems(deps())).toEqual([expect.stringMatching(/^the Bittensor adapter holds 1000000000000000000 wei of TAO, less than the 2000000000000000000 its parks owe/)]);
  });

  describe("the rest of list B (T50 review I2): each check that fails stops the keeper with its own reason", () => {
    const dep = () => fromRecord();
    const problems = async (w: World, d: DeploymentV32 = dep()) => forLifeProblems(depsFor(w, freshMemory(), d).deps);

    it("getRejectStakingHotkeyGrowth(the vault's coldkey) is true: read for the coldkey the vault's address maps to", async () => {
      const d = dep();
      const w = healthyFromRecord(d);
      const asked: unknown[] = [];
      w.answers[`${ADDR.staking.toLowerCase()}:getRejectStakingHotkeyGrowth`] = (args) => (asked.push(args[0]), true);
      expect(await problems(w, d)).toEqual([]);
      expect(asked).toEqual([addressMapping(d.addresses.vault)]);
      w.answers[`${ADDR.staking.toLowerCase()}:getRejectStakingHotkeyGrowth`] = () => false;
      expect(await problems(w, d)).toEqual([
        `the staking precompile's getRejectStakingHotkeyGrowth(the vault's coldkey ${addressMapping(d.addresses.vault)}) is false, not true: the vault's coldkey takes stake on hotkeys it never listed`,
      ]);
    });

    it("each oracle pool's observation slots in use: at least the oracle's MIN_CARDINALITY, read from the deployed oracle (never a block time assumed)", async () => {
      const d = dep();
      const w = healthyFromRecord(d);
      const taoWeth = d.forLife.pools.find((p) => p.pair === "TAO/WETH")!;
      w.answers[`${taoWeth.address.toLowerCase()}:slot0`] = () => slot0(1_801);
      expect(await problems(w, d)).toEqual([]);
      w.answers[`${taoWeth.address.toLowerCase()}:slot0`] = () => slot0(1_800);
      expect(await problems(w, d)).toEqual([`Base: the oracle's TAO/WETH pool ${taoWeth.address} has 1800 observation slots in use, fewer than the oracle's MIN_CARDINALITY 1801`]);
      // an oracle built with another minimum is judged by its own
      w.answers[`${d.addresses.oracle.toLowerCase()}:MIN_CARDINALITY`] = () => 901;
      expect(await problems(w, d)).toEqual([]);
    });

    it("each oracle pool's fee(), read on its own, as planned", async () => {
      const d = dep();
      const w = healthyFromRecord(d);
      const wethUsdc = d.forLife.pools.find((p) => p.pair === "WETH/USDC")!;
      w.answers[`${wethUsdc.address.toLowerCase()}:fee`] = () => 3000;
      expect(await problems(w, d)).toEqual([`Base: the oracle's WETH/USDC pool ${wethUsdc.address}'s fee() is 3000, not 500 as planned`]);
    });

    it("lastStakeAt between the vault's creation and the head, read at one block", async () => {
      const d = dep();
      const w = healthyFromRecord(d);
      const lens = `${d.addresses.vaultLens.toLowerCase()}:lastStakeAt`;
      for (const ok of [CREATED, T]) {
        w.answers[lens] = () => BigInt(ok);
        expect(await problems(w, d), String(ok)).toEqual([]);
      }
      w.answers[lens] = () => BigInt(CREATED - 1);
      expect(await problems(w, d)).toEqual([`Bittensor CascadeVaultLens's lastStakeAt() is ${CREATED - 1}, before the vault's creation at ${CREATED}`]);
      w.answers[lens] = () => BigInt(T + 1);
      expect(await problems(w, d)).toEqual([`Bittensor CascadeVaultLens's lastStakeAt() is ${T + 1}, after the head's time ${T} (block 10000)`]);
    });

    it("the deployment's vaultColdkey is the address mapping of the vault (blake2b, as plan.ts computes it)", async () => {
      const d = dep();
      const w = healthyFromRecord(d);
      const wrong = { ...d, vaultColdkey: `0x${"c0".repeat(32)}` as Hex };
      // the staking flag is still read for the vault's own coldkey, never the deployment's word for it
      const asked: unknown[] = [];
      w.answers[`${ADDR.staking.toLowerCase()}:getRejectStakingHotkeyGrowth`] = (args) => (asked.push(args[0]), true);
      expect(await problems(w, wrong)).toEqual([
        `the deployment's vaultColdkey 0x${"c0".repeat(32)} is not the vault's coldkey ${addressMapping(d.addresses.vault)}, the address mapping of ${d.addresses.vault}: the deployment was changed after it was built`,
      ]);
      expect(asked).toEqual([addressMapping(d.addresses.vault)]);
      // the core's mapping is plan.ts's
      for (const a of [d.addresses.vault, ADDR.vault, KEY.address]) expect(addressMapping(a)).toBe(planAddressMapping(a));
    });

    it("through the round's readiness: a for-life check that fails stops the keeper (KeeperNotReady), naming it", async () => {
      const w = world();
      w.vault.rejectGrowth = false;
      const e = await checkReadyV32(depsFor(w).deps, freshMemory(), T * 1000).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(KeeperNotReady);
      expect(classifyFailure(e)).toMatchObject({ stop: true, kind: "not-ready" });
      expect((e as Error).message).toMatch(/is not as it must be: the staking precompile's getRejectStakingHotkeyGrowth\(the vault's coldkey 0x[0-9a-f]{64}\) is false, not true/);
    });
  });

  it("Task 65: the vault's EXIT_GAS_RESERVE (served by its lens) is the keeper's own, 2,000,000, for life: a deployed vault that reads otherwise stops the keeper before any payout is sent", async () => {
    const dep = fromRecord();
    expect(EXIT_GAS_RESERVE).toBe(2_000_000n);
    expect(dep.forLife.values.filter((v) => v.fn === "EXIT_GAS_RESERVE")).toEqual([
      { chain: "bittensor", contract: "CascadeVaultLens", address: getAddress(record().plan.addresses.vaultLens), fn: "EXIT_GAS_RESERVE", returns: "uint256", want: "2000000" },
    ]);
    const w = healthyFromRecord(dep);
    expect(await forLifeProblems(depsFor(w, freshMemory(), dep).deps)).toEqual([]);
    // a vault built with the old reserve: the keeper's payouts would carry less than its walk leaves
    w.answers[`${dep.addresses.vaultLens.toLowerCase()}:EXIT_GAS_RESERVE`] = () => 1_200_000n;
    expect(await forLifeProblems(depsFor(w, freshMemory(), dep).deps)).toEqual(["Bittensor CascadeVaultLens's EXIT_GAS_RESERVE() is 1200000, not 2000000"]);
    // through the round's readiness (the first round reads the for-life list before anything is sent): the keeper stops
    w.answers[`${dep.addresses.vaultLens.toLowerCase()}:keeper`] = () => KEY.address;
    w.answers[`${dep.addresses.frontDoor.toLowerCase()}:keeper`] = () => KEY.address;
    const e = await checkReadyV32(depsFor(w, freshMemory(), dep).deps, freshMemory(), T * 1000).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KeeperNotReady);
    expect(classifyFailure(e)).toMatchObject({ stop: true, kind: "not-ready" });
    expect((e as Error).message).toMatch(/is not as it must be: Bittensor CascadeVaultLens's EXIT_GAS_RESERVE\(\) is 1200000, not 2000000; nothing sent$/);
  });

  it("a library's or a lens's balance never stops the keeper: nothing reads one", async () => {
    const dep = deploymentFor();
    const w = world();
    w.balances[ADDR.vaultLens.toLowerCase()] = 5n * TAO;
    w.balances[ADDR.doorLens.toLowerCase()] = 5n * TAO;
    await checkReadyV32(depsFor(w, freshMemory(), dep).deps, freshMemory(), T * 1000);
    expect(w.balanceReads.map((a) => a.toLowerCase())).not.toContain(ADDR.vaultLens.toLowerCase());
    expect(w.balanceReads.map((a) => a.toLowerCase())).not.toContain(ADDR.doorLens.toLowerCase());
    // and with the record's whole for-life list (T50 review M5): every lens and library holding TAO, none read
    const rec = record();
    const full = fromRecord(rec);
    const v = healthyFromRecord(full);
    const others = (["vaultLens", "doorLens", "payoutMath", "stakeLib", "payoutLib", "batchLib", "hotkeyLib"] as const).map((id) => rec.plan.addresses[id].toLowerCase());
    for (const a of others) v.balances[a] = 5n * TAO;
    expect(await forLifeProblems(depsFor(v, freshMemory(), full).deps)).toEqual([]);
    expect(v.balanceReads.map((a) => a.toLowerCase()).filter((a) => others.includes(a))).toEqual([]);
    expect(v.calls.length).toBeGreaterThan(full.forLife.values.length);
  });

  it("a wrong value stops the keeper (KeeperNotReady); a read that fails only fails the round; the for-life list is read once an hour", async () => {
    const w = world();
    w.vault.keeper = getAddress(`0x${"99".repeat(20)}`);
    const e = await checkReadyV32(depsFor(w).deps, freshMemory(), T * 1000).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KeeperNotReady);
    expect(classifyFailure(e)).toMatchObject({ stop: true, kind: "not-ready" });

    const down = world();
    down.answers[`${ADDR.vaultLens.toLowerCase()}:keeper`] = () => {
      throw new RpcError("bittensor eth_call: HTTP 503");
    };
    const f = await checkReadyV32(depsFor(down).deps, freshMemory(), T * 1000).catch((x: unknown) => x);
    expect(classifyFailure(f)).toMatchObject({ stop: false });

    const hourly = world();
    const m = freshMemory();
    const parks = () => hourly.calls.filter((c) => c.fn === "parkedNative").length;
    await checkReadyV32(depsFor(hourly, m).deps, m, T * 1000);
    await checkReadyV32(depsFor(hourly, m).deps, m, T * 1000 + FOR_LIFE_EVERY_MS - 1);
    expect(parks()).toBe(1);
    await checkReadyV32(depsFor(hourly, m).deps, m, T * 1000 + FOR_LIFE_EVERY_MS);
    expect(parks()).toBe(2);
  });

  it("the round checks it first: a key keeper() no longer names stops the keeper before anything is sent", async () => {
    const w = world();
    w.door.start = BigInt(T - 90_000);
    w.vault.keeper = getAddress(`0x${"99".repeat(20)}`);
    const lines: string[] = [];
    const m = freshMemory();
    const r = await runRound(depsFor(w, m, deploymentFor(), (l) => lines.push(l)).deps, targetV32(deploymentFor()), m, { ...OPTS, now: () => T * 1000 });
    expect(r.end).toMatchObject({ stopped: true, kind: "not-ready" });
    expect(w.sends).toEqual([]);
    expect(lines.at(-1)).toMatch(/^Stopped: the v3.2 deployment v3.2-launch is not as it must be: the vault's keeper\(\) is 0x9999/);
    // healthy, the same round closes the batch
    const v = world();
    v.door.start = BigInt(T - 90_000);
    const mv = freshMemory();
    await runRound(depsFor(v, mv).deps, targetV32(deploymentFor()), mv, { ...OPTS, now: () => T * 1000 });
    expect(v.sends.map((s) => s.fn)).toEqual(["closeBatch"]);
    expect(KEY.address).toBe(deploymentFor().keeper);
  });
});

