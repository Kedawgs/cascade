import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, numberToHex, stringToBytes, toFunctionSelector } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { USAGE } from "../src/args.ts";
import { POOL_ABI } from "../src/cardinality.ts";
import { BASE_V3, type ChainName, paths } from "../src/config.ts";
import { saveRecord } from "../src/record.ts";
import type { Rpc } from "../src/rpc.ts";
import { type BuildRefV32, type BuildV32, freezeBuildV32, writeBuildV32 } from "../src/v32/build.ts";
import {
  BASE_L1_PER_CALL,
  type BudgetInputsV32,
  budgetCommandV32,
  computeBudgetV32,
  CUSHION_DEPOSIT,
  FOUNDER_STEPS_V32,
  formatBudgetV32,
  FULL_CLOSE_QUOTE_V32,
  gatherBudgetInputsV32,
  MARGIN_PCT_V32,
  PUBLIC_RPCS_V32,
  RELAYER_DAYS,
  STAMP_GAS_ALLOWANCE,
  STAMPS_PER_DAY,
} from "../src/v32/budget.ts";
import { type DeploymentRecordV32, fundingNeed, gasCeiling } from "../src/v32/deploy.ts";
import type { PlanV32 } from "../src/v32/plan.ts";
import { FM_DEPOSIT } from "../src/v32/rehearse.ts";
import { FUNDING_V32, SETTINGS_V32_LAUNCH } from "../src/v32/settings.ts";
import { closeValue } from "../src/keeper/core/actions.ts";
import { SPEND_CAP_DEFAULT } from "../src/keeper/deployment-v32.ts";
import { fakeChain } from "./fake-keeper.ts";
import { tempDir } from "./v32-chains.ts";
import { planV32, ROLES_V32 } from "./v32-fixtures.ts";

// The off-chain report's concern 6 (T65 prep): `pnpm ops budget` for v3.2, what the founder funds the fresh deployer
// keystores (Task 66 step 4: "funded with the plan's budget and margin") and the relayer with, from the rehearsal
// record's measured gas, the founder's steps after the creates, the pools' cardinality and today's gas prices read from
// public RPCs. v3-launch's budget (budget.ts) is untouched: test/budget.test.ts holds it.

const CONTRACTS = paths({}).contractsDir;
const GWEI = 10n ** 9n;
const TAO_PRICE = 5n * GWEI;
const BASE_PRICE = 6_000_000n;

let build: BuildV32;
let ref: BuildRefV32;
let buildsDir: string;
let plan: PlanV32;

beforeAll(async () => {
  const frozen = await freezeBuildV32(CONTRACTS);
  build = frozen.build;
  buildsDir = join(tempDir("budget"), "builds");
  ref = writeBuildV32(buildsDir, frozen);
  plan = planV32();
});

/** A finished rehearsal record of `plan`: each create done with `gas(i)` gas, verified, its build named as rehearsed. */
function rehearsal(over: Partial<DeploymentRecordV32> = {}, gas = (i: number) => 1_000_000n + BigInt(i)): DeploymentRecordV32 {
  return {
    target: "rehearsal",
    createdAt: "2026-11-14T09:16:42.153Z",
    plan,
    build: ref,
    done: Object.fromEntries(plan.steps.map((s, i) => [s.id, { hash: "0x", block: 1, gasUsed: gas(i), costWei: 0n, address: plan.addresses[s.id] }])) as DeploymentRecordV32["done"],
    verify: { ok: true, failures: [], checkedAt: "2026-11-14T09:18:32.732Z" },
    rehearsed: { buildHash: ref.hash, at: "2026-11-14T09:23:18.546Z" },
    ...over,
  };
}

/** Base and Bittensor as the public RPCs answer the budget: each chain's gas price, Base's headers (five blocks a second,
 * 40M gas each), the oracle's two pools at `taoWeth` and `wethUsdc` slots (in use, and reserved), and an eth_call with a
 * code override (the rehearsed oracle's MIN_CARDINALITY, run from its frozen runtime), answering `minCardinality`: each
 * such call kept in `overrides`. */
function publicChains(o: { taoWeth?: { cardinality: number; next: number }; wethUsdc?: number; minCardinality?: number } = {}) {
  const chain = fakeChains(o);
  const overrides: { chain: ChainName; to: string; data: string; code?: string }[] = [];
  const rpc: Rpc = {
    async request(c, method, params) {
      if (method === "eth_call" && params[2] !== undefined) {
        const [tx, , over] = params as [{ to: string; data: string }, string, Record<string, { code?: string }>];
        overrides.push({ chain: c, to: tx.to, data: tx.data, code: over[tx.to]?.code });
        return encodeAbiParameters([{ type: "uint16" }], [o.minCardinality ?? 1_801]);
      }
      return chain.ctx.rpc.request(c, method, params);
    },
  };
  return { rpc, calls: chain.calls, overrides };
}

function fakeChains(o: { taoWeth?: { cardinality: number; next: number }; wethUsdc?: number }) {
  const taoWeth = o.taoWeth ?? { cardinality: 2_000, next: 2_000 };
  return fakeChain(
    [POOL_ABI],
    {
      slot0: (_a, c) => {
        const s = c.to.toLowerCase() === BASE_V3.TAO_WETH_POOL.toLowerCase() ? taoWeth : { cardinality: o.wethUsdc ?? 6_700, next: o.wethUsdc ?? 6_700 };
        return [2n ** 96n, 0, 0, s.cardinality, s.next, 0, true];
      },
    },
    {
      eth_gasPrice: (chain: ChainName) => numberToHex(chain === "base" ? BASE_PRICE : TAO_PRICE),
      eth_getBlockByNumber: (_c: ChainName, params: unknown[]) => {
        const head = 57_134_080;
        const n = params[0] === "latest" ? head : Number(BigInt(params[0] as string));
        return { number: numberToHex(n), timestamp: numberToHex(1_794_617_191 - Math.floor((head - n) * 0.2)), gasLimit: numberToHex(40_000_000) };
      },
    },
  );
}

/** An RPC that fails the test on any call: what a refusal must never reach. */
const untouched: Rpc = {
  async request(chain, method) {
    throw new Error(`nothing may be read, but ${method} was asked of ${chain}`);
  },
};

/** Fixed inputs: two creates on each chain, today's prices, both pools holding the oracle's minimum. */
const inputs = (over: Partial<BudgetInputsV32> = {}): BudgetInputsV32 => ({
  path: "ops/deployments/rehearsal-v3.2-launch.json",
  buildHash: "0x8c3bcb22ffb2a97da9d9c349b601d6ae0c3f24c3f49904f37f5f93cd88826ebd",
  rehearsedAt: "2026-11-14T09:23:18.546Z",
  creates: [
    { id: "bitAdapter", chain: "bittensor", gasUsed: 10_000_000n, ceiling: 12_000_000n },
    { id: "vault", chain: "bittensor", gasUsed: 4_000_000n, ceiling: 6_000_000n },
    { id: "baseAdapter", chain: "base", gasUsed: 6_000_000n, ceiling: 8_000_000n },
    { id: "frontDoor", chain: "base", gasUsed: 3_000_000n, ceiling: 4_000_000n },
  ],
  roles: { owner: ROLES_V32.owner, guardian: ROLES_V32.guardian, treasury: ROLES_V32.treasury },
  gasPrice: { bittensor: TAO_PRICE, base: BASE_PRICE },
  priceFrom: PUBLIC_RPCS_V32,
  pools: [
    { name: "TAO/WETH 0.3% pool", address: BASE_V3.TAO_WETH_POOL, cardinality: 2_000, next: 2_000, steps: [] },
    { name: "WETH/USDC 0.05% pool", address: BASE_V3.WETH_USDC_POOL, cardinality: 6_700, next: 6_700, steps: [] },
  ],
  cardinalityTarget: 1_801,
  warnings: [],
  keeperSpendCap: 10n ** 16n,
  ...over,
});

describe("pnpm ops budget for v3.2 (the off-chain report's concern 6)", () => {
  it("refuses with a clear message when there is no v3.2 rehearsal record, reading nothing", async () => {
    const path = join(tempDir("budget-none"), "rehearsal-v3.2-launch.json");
    expect(existsSync(path)).toBe(false);
    await expect(budgetCommandV32(untouched, { path, contractsDir: CONTRACTS, buildsDir })).rejects.toThrow(
      `there is no v3.2 rehearsal record at ${path}: run pnpm ops rehearse --v32 first (OPS_DEPLOYMENT=v3.2-launch); the budget prices the deployment from its measured gas; nothing read`,
    );
  });

  it("refuses a rehearsal record that can't price the deployment, naming why, reading nothing", async () => {
    const dir = tempDir("budget-unfinished");
    const missing = rehearsal();
    delete missing.done.vault;
    for (const [rec, why] of [
      [rehearsal({ rehearsed: undefined }), "it names no rehearsed build (pnpm ops rehearse --v32 writes it once everything passed)"],
      [rehearsal({ void: { at: "2026-11-14T00:00:00Z", reason: "a nonce spent outside the plan" } }), "its plan is void (a nonce spent outside the plan)"],
      [rehearsal({ verify: undefined }), "it was never verified"],
      [rehearsal({ verify: { ok: false, failures: ["Bittensor CascadeVault: wrong"], checkedAt: "x" } }), "its verify failed"],
      [missing, "1 create with no measured gas (vault)"],
      [rehearsal({ pending: { step: "vault", chain: "bittensor", nonce: 6, hashes: [] } }), "a create still pending"],
      [rehearsal({ rehearsed: { buildHash: `0x${"ab".repeat(32)}`, at: "x" } }), "its build is not the one it names as rehearsed"],
    ] as const) {
      const path = join(dir, `${why.slice(0, 12).replace(/\W/g, "-")}.json`);
      saveRecord(path, rec);
      await expect(budgetCommandV32(untouched, { path, contractsDir: CONTRACTS, buildsDir }), why).rejects.toThrow(
        `the v3.2 rehearsal record ${path} can't price the deployment (${why}): run pnpm ops rehearse --v32 again; nothing read`,
      );
    }
  });

  it("gathers the measured gas and the ceilings from the record and its frozen build, and today's prices and the pools from public RPCs", async () => {
    const { rpc, calls } = publicChains();
    const i = await gatherBudgetInputsV32(rpc, rehearsal(), { path: "the record", contractsDir: CONTRACTS, buildsDir });
    expect(i.creates).toEqual(plan.steps.map((s, n) => ({ id: s.id, chain: s.chain, gasUsed: 1_000_000n + BigInt(n), ceiling: gasCeiling(build, s) })));
    expect([i.buildHash, i.rehearsedAt, i.path]).toEqual([ref.hash, "2026-11-14T09:23:18.546Z", "the record"]);
    expect(i.roles).toEqual({ owner: ROLES_V32.owner, guardian: ROLES_V32.guardian, treasury: ROLES_V32.treasury });
    expect(i.gasPrice).toEqual({ bittensor: TAO_PRICE, base: BASE_PRICE });
    expect(i.cardinalityTarget).toBe(1_801);
    expect(i.pools).toEqual([
      { name: "TAO/WETH 0.3% pool", address: BASE_V3.TAO_WETH_POOL, cardinality: 2_000, next: 2_000, steps: [] },
      { name: "WETH/USDC 0.05% pool", address: BASE_V3.WETH_USDC_POOL, cardinality: 6_700, next: 6_700, steps: [] },
    ]);
    // the checkout's contracts/out is the rehearsed build: nothing to warn of
    expect(i.warnings).toEqual([]);
    // reads only: gas prices, Base's headers, the pools' slot0, and the one call below
    expect(calls.every((c) => ["eth_gasPrice", "eth_getBlockByNumber"].includes(c.method) || (c.method === "eth_call" && c.fn === "slot0"))).toBe(true);
    // a short pool gets the steps that grow it, at most 600 new slots each
    const short = await gatherBudgetInputsV32(publicChains({ taoWeth: { cardinality: 900, next: 1_000 } }).rpc, rehearsal(), { path: "p", contractsDir: CONTRACTS, buildsDir });
    expect(short.pools[0].steps).toEqual([1_600, 1_801]);
    // the public RPCs it reads by default: no key in either
    expect(PUBLIC_RPCS_V32).toEqual({ base: "https://mainnet.base.org", bittensor: "https://lite.chain.opentensor.ai" });
  });

  it("the pools' target is the rehearsed oracle's own MIN_CARDINALITY, run from its frozen runtime, never the checkout's (the review of 99d4b07)", async () => {
    const { rpc, overrides } = publicChains({ minCardinality: 2_500 });
    const i = await gatherBudgetInputsV32(rpc, rehearsal(), { path: "p", contractsDir: CONTRACTS, buildsDir });
    // one eth_call on Base, MIN_CARDINALITY() at a scratch address whose code is the frozen oracle's runtime
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ chain: "base", data: toFunctionSelector("MIN_CARDINALITY()"), code: build.contracts.CascadeTwapOracle.deployedBytecode.object });
    // 2,500 is more than Base's block time needs (1,801 at 0.2 s): the target; the 2,000-slot pool grows, the 6,700 doesn't
    expect(i.cardinalityTarget).toBe(2_500);
    expect(i.pools.map((p) => p.steps)).toEqual([[2_500], []]);
  });

  it("warns when the checkout's contracts/out is not the rehearsed build, which deploy --v32 would refuse (the review of 99d4b07)", async () => {
    // the rehearsed build: the checkout's with one byte of the door lens's runtime changed
    const other = structuredClone(build);
    const code = other.contracts.CascadeDoorLens.deployedBytecode.object;
    other.contracts.CascadeDoorLens.deployedBytecode.object = `${code.slice(0, -2)}${code.endsWith("00") ? "01" : "00"}` as typeof code;
    const text = JSON.stringify(other, null, 2);
    const otherRef = writeBuildV32(buildsDir, { text, hash: keccak256(stringToBytes(text)) });
    const rec = rehearsal({ build: otherRef, rehearsed: { buildHash: otherRef.hash, at: "2026-11-14T09:23:18.546Z" } });
    const i = await gatherBudgetInputsV32(publicChains().rpc, rec, { path: "p", contractsDir: CONTRACTS, buildsDir });
    expect(i.warnings).toEqual([
      "this checkout's contracts/out is not the build the rehearsal deployed (CascadeDoorLens differs): deploy --v32 sends only the rehearsed build, so it would refuse this checkout; build the rehearsed contracts, or rehearse again. The figures below are the rehearsed build's.",
    ]);
    expect(formatBudgetV32(computeBudgetV32(inputs({ warnings: i.warnings })))[1]).toBe(`Warning: ${i.warnings[0]}`);
  });

  it("each deployer gets deploy --v32's own funding check with the margin, so a funded deployer passes it", () => {
    const b = computeBudgetV32(inputs());
    expect(MARGIN_PCT_V32).toBe(30n);
    // Bittensor: 14,000,000 gas used, 0.07 TAO at 5 gwei; the ceilings, 18,000,000 gas at twice the price, 0.18 TAO,
    // the larger; with 30%, 0.234 TAO
    expect(b.chains.bittensor.deployer).toEqual({ creates: 2, gasUsed: 14_000_000n, spent: 7n * 10n ** 16n, ceiling: 18_000_000n, deployNeed: 18n * 10n ** 16n, send: 234n * 10n ** 15n });
    // Base: 9,000,000 gas used at 0.006 gwei, 0.000054 ETH, and 0.0001 ETH of L1 fee a create; the ceilings at twice the
    // price, 0.000144 ETH, and the same L1 allowance, 0.000344 ETH; with 30%, 0.0004472, rounded up to 0.0005 ETH
    expect(b.chains.base.deployer).toEqual({ creates: 2, gasUsed: 9_000_000n, spent: 254n * 10n ** 12n, ceiling: 12_000_000n, deployNeed: 344n * 10n ** 12n, send: 5n * 10n ** 14n });
  });

  it("the deployer's need is deploy --v32's fundingNeed for the record's creates, at the price read", async () => {
    const i = await gatherBudgetInputsV32(publicChains().rpc, rehearsal(), { path: "p", contractsDir: CONTRACTS, buildsDir });
    const b = computeBudgetV32(i);
    for (const chain of ["bittensor", "base"] as const) {
      const steps = plan.steps.filter((s) => s.chain === chain);
      expect(b.chains[chain].deployer.deployNeed, chain).toBe(fundingNeed(build, steps, chain, i.gasPrice[chain]));
      expect(b.chains[chain].deployer.send, chain).toBeGreaterThanOrEqual(fundingNeed(build, steps, chain, i.gasPrice[chain]));
    }
  });

  it("the founder's steps after the creates: each account sized as a wallet checks it, its limits at twice the price, with the margin, and the funding's TAO", () => {
    const b = computeBudgetV32(inputs());
    const share = (chain: ChainName, account: string) => b.chains[chain].founder.find((f) => f.account === account);
    // a wallet sends each call with its estimate and a quarter (rounded up) as its gas limit, and wants the balance to
    // cover that limit at its max fee, about twice the price (the review of 99d4b07, M5; the deployer's sizing): the
    // funding account's 23,208 + 500,000 (an allowance) + 46,365 + 81,898 = 651,471 gas used are limits of 29,010 +
    // 625,000 + 57,957 + 102,373 = 814,340, at 10 gwei 0.0081434 TAO, 0.01058642 with 30%; and the TAO it sends, the
    // reserve's 0.0010005 and depositLiquid's 0.002
    expect(share("bittensor", "funder")).toMatchObject({ gas: 651_471n, limit: 814_340n, value: 3_000_500_000_000_000n, need: 10_586_420_000_000_000n + 3_000_500_000_000_000n });
    expect(share("bittensor", "treasury")).toMatchObject({ address: ROLES_V32.treasury, gas: 46_215n, limit: 57_769n, need: 750_997_000_000_000n });
    // R6b (the R6 carry): a write-off's execute is an optional line, held only if a write-off is planned: the owner's share
    // is its setKeeper and setIdleBuffer, 79,195 gas, limits of 98,994, at 10 gwei with 30%: 0.001286922 TAO; the
    // write-off apart, sent with the file's own 47,000,000 gas limit (no quarter more), at 10 gwei with 30%: 0.611 TAO
    expect(share("bittensor", "owner")).toMatchObject({ address: ROLES_V32.owner, gas: 79_195n, limit: 98_994n, need: 1_286_922_000_000_000n });
    expect(share("bittensor", "owner")?.optional).toMatchObject({ steps: [expect.objectContaining({ label: "execute(writeOffMissingStake)" })], limit: 47_000_000n, need: 611_000_000_000_000_000n });
    expect(share("bittensor", "treasury")?.optional).toBeUndefined();
    expect(share("bittensor", "guardian")).toMatchObject({ address: ROLES_V32.guardian, gas: 54_105n, limit: 67_632n, need: 879_216_000_000_000n });
    // Base: the same, each call with its L1 fee allowance (0.00004 ETH): the owner's setKeeper and unpause, the guardian's
    // pause and disableBridge
    expect(share("base", "owner")).toMatchObject({ gas: 56_057n, limit: 70_072n, need: 105_093_123_200_000n });
    expect(share("base", "guardian")).toMatchObject({ gas: 103_792n, limit: 129_741n, need: 106_023_959_600_000n });
    expect(BASE_L1_PER_CALL).toBe(4n * 10n ** 13n);
    // the steps the rehearsal ran: runbook 3.2's funding, the treasury's redeem origin, the settings (2.6, 7.1, 7.6)
    expect(FOUNDER_STEPS_V32.map((s) => `${s.chain} ${s.account} ${s.label}`)).toEqual([
      "bittensor funder fundReserve()",
      "bittensor funder depositLiquid",
      "bittensor funder approve",
      "bittensor funder fundCushion",
      "bittensor treasury setRedeemOrigin",
      "bittensor owner setKeeper",
      "bittensor owner setIdleBuffer",
      "bittensor owner execute(writeOffMissingStake)",
      "bittensor guardian disableBridge",
      "base owner setKeeper",
      "base guardian pause",
      "base owner unpause",
      "base guardian disableBridge",
    ]);
    // the emergency steps the rehearsal practised are drills, not launch steps (the review of 99d4b07)
    expect(FOUNDER_STEPS_V32.filter((s) => s.drill).map((s) => `${s.chain} ${s.account} ${s.label}`)).toEqual([
      "bittensor guardian disableBridge",
      "base guardian pause",
      "base owner unpause",
      "base guardian disableBridge",
    ]);
    // depositLiquid's TAO is the rehearsal's: what mints the cushion's FM-TAO, the chain's minimum stake
    expect(CUSHION_DEPOSIT).toBe(FM_DEPOSIT);
    expect(FUNDING_V32.adapterReserve + CUSHION_DEPOSIT).toBe(3_000_500_000_000_000n);
  });

  it("the cardinality costs nothing while both pools hold the oracle's 1,801, and the grow steps when one is short", () => {
    expect(computeBudgetV32(inputs()).chains.base.cardinality).toEqual({ txs: 0, gas: 0n, limit: 0n, need: 0n });
    const pools = inputs().pools.map((p, n) => (n === 0 ? { ...p, cardinality: 900, next: 1_000, steps: [1_600, 1_801] } : p));
    // 600 + 201 new slots at 22,500 gas; at their gas limits (25,000 a slot + 100,000 each) 20,225,000 gas, at twice 0.006
    // gwei as a wallet checks it, with Base's L1 allowance for each, and 30%
    expect(computeBudgetV32(inputs({ pools })).chains.base.cardinality).toEqual({ txs: 2, gas: 18_022_500n, limit: 20_225_000n, need: 419_510_000_000_000n });
  });

  it("the relayer: a stamp every 12 hours on each chain for 30 days, at an allowance of 100,000 gas each", () => {
    const b = computeBudgetV32(inputs());
    expect([STAMPS_PER_DAY, RELAYER_DAYS, STAMP_GAS_ALLOWANCE]).toEqual([2n, 30n, 100_000n]);
    // 6,000,000 gas: 0.03 TAO at 5 gwei, 0.039 with 30%
    expect(b.chains.bittensor.relayer).toEqual({ stamps: 60n, gas: 6_000_000n, need: 39n * 10n ** 15n, send: 39n * 10n ** 15n });
    // 0.000036 ETH at 0.006 gwei and 60 × 0.00004 ETH of L1 fee; with 30%, 0.0031668, rounded up to 0.0032 ETH
    expect(b.chains.base.relayer).toEqual({ stamps: 60n, gas: 6_000_000n, need: 3_166_800_000_000_000n, send: 32n * 10n ** 14n });
  });

  it("R12a: the keeper's ETH on Base: the float a full 50 + 50 batch's close sends (three quotes) beside its 24 h spend cap, with the margin", () => {
    // the largest close's quote: Base's router asked 0.0042646 ETH for the 7,000,000 gas toward Bittensor a 50 + 50 batch
    // asks (1,300,000 + 57,000 × 100), on 2026-10-21; rounded up
    expect(FULL_CLOSE_QUOTE_V32).toBe(43n * 10n ** 14n);
    expect(SETTINGS_V32_LAUNCH.gas.towardBittensor.base + 100n * SETTINGS_V32_LAUNCH.gas.towardBittensor.perEntry).toBe(7_000_000n);
    // the launch's request fee (the founder, 2026-11-16: 0.0002 ETH): a full redeem list, 50 requests, pays 0.01 ETH, about
    // 2.3 times that quote, above the 1.5 times under which the monitor's batch.redeem_fee_thin warns (redeemFeeCoverPct)
    const fd = SETTINGS_V32_LAUNCH.frontDoor;
    expect(fd.redeemRequestFee).toBe(2n * 10n ** 14n);
    expect(fd.redeemRequestFee * BigInt(fd.maxRedeems)).toBe(10n ** 16n);
    expect(fd.redeemRequestFee * BigInt(fd.maxRedeems) * 100n >= FULL_CLOSE_QUOTE_V32 * 150n).toBe(true);
    expect((fd.redeemRequestFee * BigInt(fd.maxRedeems) * 100n) / FULL_CLOSE_QUOTE_V32).toBe(232n);
    const b = computeBudgetV32(inputs());
    // three quotes, 0.0129 ETH (the keeper's own closeValue), and the 0.01 ETH cap: 0.0229; with 30%, 0.02977, rounded up
    // to 0.0298 ETH
    expect(b.chains.base.keeper).toEqual({ quote: 43n * 10n ** 14n, float: 129n * 10n ** 14n, cap: 10n ** 16n, need: 29_770_000_000_000_000n, send: 298n * 10n ** 14n });
    expect(closeValue(FULL_CLOSE_QUOTE_V32)).toBe(b.chains.base.keeper?.float);
    // Bittensor's keeper TAO is runbook 2.2's (one claim's up-front fee and a day of payouts and stakes), not priced here
    expect(b.chains.bittensor.keeper).toBeUndefined();
    // a cap raised by OPS_KEEPER_SPEND_CAP_BASE raises it with it: (0.0129 + 0.02) × 1.3 = 0.04277, 0.0428 ETH
    expect(computeBudgetV32(inputs({ keeperSpendCap: 2n * 10n ** 16n })).chains.base.keeper?.send).toBe(428n * 10n ** 14n);
    // the launch default when the CLI passes none
    expect(SPEND_CAP_DEFAULT.base).toBe(10n ** 16n);
  });

  it("prints per chain the gas, the price used, each amount with the margin, and the sends", () => {
    const lines = formatBudgetV32(computeBudgetV32(inputs()));
    expect(lines[0]).toBe(
      "The v3.2 deployment's budget, from the rehearsal record ops/deployments/rehearsal-v3.2-launch.json (build 0x8c3bcb22ffb2a97da9d9c349b601d6ae0c3f24c3f49904f37f5f93cd88826ebd, rehearsed 2026-11-14T09:23:18.546Z), at the gas prices read now from public RPCs, each amount with a 30% margin:",
    );
    expect(lines).toContain("Bittensor: gas price 5 gwei (eth_gasPrice at https://lite.chain.opentensor.ai)");
    expect(lines).toContain(
      "  The deployer, a fresh key (OPS_V32_DEPLOYER_BITTENSOR_KEYSTORE): its 2 creates used 14,000,000 gas in the rehearsal, 0.07 TAO at that price. deploy --v32 refuses to start unless it holds the creates' ceilings, 18,000,000 gas, at twice the price: 0.18 TAO. Send it 0.234 TAO.",
    );
    expect(lines).toContain(
      "    the funding account (any account you hold; runbook 3.2): fundReserve() 23,208, depositLiquid 500,000 (an allowance: 90,724 on the forks, against a stand-in for Bittensor's staking), approve 46,365, fundCushion 81,898: 651,471 gas, 814,340 as wallet limits (a quarter more) at twice the price: 0.01058642 TAO with the margin, and the 0.0030005 TAO it sends (0.0010005 with fundReserve(), 0.002 with depositLiquid, which mints the 0.001 FM-TAO cushion): about 0.01358692 TAO",
    );
    expect(lines).toContain(
      `    the owner ${ROLES_V32.owner}: setKeeper 30,639, setIdleBuffer 48,556: 79,195 gas, 98,994 as wallet limits (a quarter more) at twice the price: 0.001286922 TAO with the margin`,
    );
    expect(lines).toContain(
      "      Only if you plan a write-off: execute(writeOffMissingStake) (an incident step, not a launch step: its file sets this gas limit, which the account must hold at the gas price up front; only the gas used is paid), 47,000,000 as its gas limit at twice the price: 0.611 TAO more with the margin. Hold it then, not now.",
    );
    // one step: its gas said once
    expect(lines).toContain(`    the treasury ${ROLES_V32.treasury}: setRedeemOrigin, 46,215 gas, 57,769 as wallet limits (a quarter more) at twice the price: 0.000750997 TAO with the margin`);
    // a drill, labelled so
    expect(lines).toContain(
      `    the guardian ${ROLES_V32.guardian}: disableBridge (a drill), 54,105 gas, 67,632 as wallet limits (a quarter more) at twice the price: 0.000879216 TAO with the margin`,
    );
    expect(lines).toContain(
      "  The founder's steps after the creates (the gas each used in the rehearsal; a drill is an emergency step it practised, not a launch step; each account holds its own share):",
    );
    expect(lines).toContain("  The vault's ED_RESERVE: 0.0000015 TAO by substrate transfer to the vault's account, from a substrate wallet (its own fee beside it).");
    expect(lines).toContain(
      "  The relayer, a fresh key (OPS_RELAYER_KEYSTORE): 60 stamps, one every 12 hours for 30 days, at 100,000 gas each (an allowance: no stamp is measured yet): 6,000,000 gas, 0.039 TAO with the margin. Send it 0.039 TAO.",
    );
    expect(lines).toContain("Base: gas price 0.006 gwei (eth_gasPrice at https://mainnet.base.org)");
    expect(lines).toContain(
      "  The deployer, a fresh key (OPS_V32_DEPLOYER_BASE_KEYSTORE): its 2 creates used 9,000,000 gas in the rehearsal, 0.000254 ETH at that price with 0.0001 ETH a create for Base's L1 fee. deploy --v32 refuses to start unless it holds the creates' ceilings, 12,000,000 gas, at twice the price, and that L1 allowance: 0.000344 ETH. Send it 0.0005 ETH.",
    );
    expect(lines).toContain(
      `    the guardian ${ROLES_V32.guardian}: pause (a drill) 49,794, disableBridge (a drill) 53,998: 103,792 gas, 129,741 as wallet limits (a quarter more) at twice the price: 0.0001060239596 ETH with the margin (0.00004 ETH a call for Base's L1 fee)`,
    );
    expect(lines).toContain("  The oracle's pools: nothing to grow, so no cost (the TAO/WETH 0.3% pool holds 2,000 slots, the WETH/USDC 0.05% pool 6,700; the oracle needs 1,801).");
    expect(lines).toContain(
      "  The relayer, a fresh key (OPS_RELAYER_KEYSTORE): 60 stamps, one every 12 hours for 30 days, at 100,000 gas each (an allowance: no stamp is measured yet): 6,000,000 gas, 0.0031668 ETH with the margin (0.00004 ETH a stamp for Base's L1 fee). Send it 0.0032 ETH.",
    );
    // R12a: the keeper's ETH on Base, after the relayer
    expect(lines).toContain(
      "  The keeper, its own key (OPS_V32_KEEPER_ADDRESS): a close sends a float of three times its bridge fee quote (the front door sends back what the fee leaves), so a full 50 + 50 batch's, at 0.0043 ETH a quote (an allowance: Base's CCIP router quoted 0.0042646 ETH for the 7,000,000 gas toward Bittensor such a batch asks, on 2026-10-21; the keeper quotes each close live), needs 0.0129 ETH on hand; beside it, its 24 h spend cap, 0.01 ETH (OPS_KEEPER_SPEND_CAP_BASE), what it may spend in a day: 0.0229 ETH, 0.02977 ETH with the margin. Send it 0.0298 ETH.",
    );
    expect(lines.findIndex((l) => l.startsWith("  The keeper, its own key"))).toBe(lines.findIndex((l) => l.startsWith("  The relayer") && l.endsWith("Send it 0.0032 ETH.")) + 1);
    expect(lines.slice(-5)).toEqual([
      "The sends:",
      "  0.234 TAO to the Bittensor deployer and 0.0005 ETH on Base to the Base deployer: Task 66 step 4's fresh keys, before pnpm ops deploy --v32 --live",
      "  0.039 TAO on Bittensor and 0.0032 ETH on Base to the relayer",
      "  0.0298 ETH on Base to the keeper, its own key (its TAO on Bittensor, about 0.45 TAO: runbook 2.2)",
      "  After the deploy, the funding it prints: 0.0000015 TAO to the vault by substrate transfer, fundReserve() with 0.0010005 TAO, and the 0.001 FM-TAO cushion (approve, then fundCushion) from depositLiquid with 0.002 TAO; each founder account above holds its share of the gas",
    ]);
    // a short pool: its transactions and their cost
    const pools = inputs().pools.map((p, n) => (n === 0 ? { ...p, cardinality: 900, next: 1_000, steps: [1_600, 1_801] } : p));
    expect(formatBudgetV32(computeBudgetV32(inputs({ pools })))).toContain(
      "  The oracle's pools: 2 transactions grow them to 1,801 slots (pnpm ops cardinality writes them; any account may send them): 18,022,500 gas, at most 20,225,000 at their gas limits, at twice the price: 0.00041951 ETH with the margin.",
    );
  });

  it("the command: the record read, the inputs gathered from public RPCs, the lines printed", async () => {
    const path = join(tempDir("budget-command"), "rehearsal-v3.2-launch.json");
    saveRecord(path, rehearsal());
    const lines = await budgetCommandV32(publicChains().rpc, { path, contractsDir: CONTRACTS, buildsDir });
    expect(lines[0]).toContain(`from the rehearsal record ${path} (build ${ref.hash}`);
    expect(lines).toContain("Base: gas price 0.006 gwei (eth_gasPrice at https://mainnet.base.org)");
    expect(lines.at(-5)).toBe("The sends:");
    // the keeper's cap as the CLI passes it (OPS_KEEPER_SPEND_CAP_BASE), else the launch default
    expect(lines).toContain("  0.0298 ETH on Base to the keeper, its own key (its TAO on Bittensor, about 0.45 TAO: runbook 2.2)");
    const raised = await budgetCommandV32(publicChains().rpc, { path, contractsDir: CONTRACTS, buildsDir, spendCap: 2n * 10n ** 16n });
    expect(raised).toContain("  0.0428 ETH on Base to the keeper, its own key (its TAO on Bittensor, about 0.45 TAO: runbook 2.2)");
  });

  it("pnpm ops budget routes a v3.2 deployment here, read from public RPCs, and v3-launch's as before", () => {
    // cli.ts runs its main on import, so its source is read
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const at = cli.indexOf('case "budget": {');
    const block = cli.slice(at, cli.indexOf('case "deploy":', at));
    // R12a: with the keeper's Base spend cap from the env (OPS_KEEPER_SPEND_CAP_BASE), as the Worker gets it
    expect(block).toMatch(
      /if \(isV32Deployment\(env\)\) \{[\s\S]*budgetCommandV32\(publicRpcV32\(\), \{ path: recordPath\(false\), contractsDir: paths\(env\)\.contractsDir, spendCap: spendCapOf\(env\)\.base \}\)[\s\S]*return 0;\s*\}/,
    );
    // v3-launch's: its own rehearsal record and its own lines
    expect(block).toContain("for (const line of formatBudget(computeBudget(await gatherBudgetInputs(ctxFor(true, cap), rehearsal, claimPolicy(env), budgetKeeper())))) log(line);");
    expect(USAGE.replace(/\s+/g, " ")).toContain("with OPS_DEPLOYMENT=v3.2-launch, what to send v3.2's fresh deployers and the relayer");
  });
});
