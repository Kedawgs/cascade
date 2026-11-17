import { existsSync, readFileSync } from "node:fs";
import { type Abi, type AbiFunction, type Address, encodePacked, getAddress, type Hex, hexToNumber, numberToHex, parseEther } from "viem";
import { BASE_V3, CADENCE, type ChainName, type Env, LIVE, PRECOMPILE } from "../config.ts";
import type { Rpc } from "../rpc.ts";
import { gettersNamed, REVERTING_STUBS } from "../v32/abi.ts";
import { type BuildV32, loadBuildV32 } from "../v32/build.ts";
import { domainSeparatorV32, expectedRuntimeV32, immutableValuesV32 } from "../v32/code.ts";
import type { DeploymentRecordV32 } from "../v32/deploy.ts";
import { routeOf } from "../v32/lens.ts";
import { CONTRACTS_V32, NONCE_PLAN, type PlanV32, type V32StepId } from "../v32/plan.ts";
import { MS_PER_BLOCK_PINS } from "../v32/classes.ts";
import { STAMP_TYPEHASH_V32 } from "../v32/verify.ts";
import { type DeploymentV32, deploymentProblems, type ForLifeCode, type ForLifePool, type ForLifeValue } from "./core/deployment.ts";
import { codeHashOf } from "./core/v32/readiness.ts";
import { EXIT_GAS_RESERVE } from "./core/v32/payout.ts";

// The PC's half of the keeper's deployment.ts (design-keeper-worker.md §1): the v3.2 deployment the core runs on,
// built from the deployment record, its frozen build and the web's own deployments.json, never from verify.ok. Task
// 50b's config-from-record writes the same object into the Worker's DEPLOYMENT var.

const RAO = 10n ** 9n;
const WEB_DEPLOYMENTS = new URL("../../../web/src/lib/cascade/deployments.json", import.meta.url);

/** OPS_PAYOUT_TOPUP_MAX: the most TAO the keeper adds to a payout's bridge fee above what its entries pay (decimal TAO,
 * e.g. 0.002), in wei; unset or empty is the founder's default, 0 (a fee above the ceiling waits). Refused unless it is
 * whole rao (the vault refuses any other value: BadValue). */
export function payoutTopUpMax(env: Env): bigint {
  const v = env.OPS_PAYOUT_TOPUP_MAX?.trim();
  if (!v) return 0n;
  if (!/^\d+(\.\d{1,18})?$/.test(v)) throw new Error(`OPS_PAYOUT_TOPUP_MAX "${v}" is not an amount of TAO (e.g. 0.002); nothing sent`);
  const wei = parseEther(v);
  if (wei % RAO !== 0n) throw new Error(`OPS_PAYOUT_TOPUP_MAX "${v}" is not a whole number of rao (at most 9 decimals); nothing sent`);
  return wei;
}

/** OPS_PARK_REFUND_FEE_MAX (Task 52): the most TAO the keeper pays as a park refund's CCIP fee (decimal TAO, e.g. 0.05),
 * in wei; unset or empty: none named, so the core's PARK_REFUND_FEE_MAX (0.05 TAO) applies. Refused unless above 0. */
export function parkRefundFeeMaxOf(env: Env): bigint | undefined {
  const v = env.OPS_PARK_REFUND_FEE_MAX?.trim();
  if (!v) return undefined;
  const wei = /^\d+(\.\d{1,18})?$/.test(v) ? parseEther(v) : 0n;
  if (wei <= 0n) throw new Error(`OPS_PARK_REFUND_FEE_MAX "${v}" is not an amount of TAO above 0 (e.g. 0.05); nothing sent`);
  return wei;
}

/** OPS_REEXEC_AUTO (Task 52 fix round 1): whether the keeper re-executes Cascade's CCIP FAILUREs by itself, "on" or "off";
 * unset or empty: none named, so off (the founder's ruling: by hand only at launch, with pnpm ops reexec). Refused unless
 * on or off. */
export function reexecAutoOf(env: Env): boolean | undefined {
  const v = env.OPS_REEXEC_AUTO?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "on") return true;
  if (v === "off") return false;
  throw new Error(`OPS_REEXEC_AUTO "${env.OPS_REEXEC_AUTO?.trim()}" is not on or off; nothing sent`);
}

/** The 24 h spend cap's defaults. Base (R12a, the ChatGPT r3 DoS scan's item 6; Task 50a's 0.0017 ETH before, a third of
 * the 0.005 ETH the keeper held): 0.01 ETH, a day's closes, about two full 50 + 50 batches (about 0.0043 ETH each, gas and
 * fee) or a dozen of one entry (about 0.00075), so one forced early close no longer stops every Base send for up to 24
 * hours; the keeper is funded with the float a full batch's close sends (three quotes) beside it, about 0.03 ETH (pnpm ops
 * budget; runbook 2.2). Bittensor (the founder, 2026-11-08, Task 51 fix round 1: the keeper claims,
 * funded with about 0.4 TAO): one claim's worst case up front (its gas limit at the fee cap) plus a day of payouts and
 * stakes; 0.4 TAO (the controller's ruling, Task 51 fix round 2), which fits a claim while Bittensor's gas price is up to
 * about 5.5 gwei since Task 65's 2,000,000 reserve, today's being about 5 (v32/claims.ts claimFitProblem says so loudly
 * when it doesn't). Kept for the self-funded launch; raised to 0.6 TAO before other people's money (the T61a review;
 * runbook 2.2). Vars: they change without code. */
export const SPEND_CAP_DEFAULT: Record<ChainName, bigint> = { base: parseEther("0.01"), bittensor: parseEther("0.4") };

/** OPS_KEEPER_SPEND_CAP_BASE (ETH) and OPS_KEEPER_SPEND_CAP_BITTENSOR (TAO): the most the keeper may spend on each chain
 * in 24 hours, gas plus value, as decimal amounts; unset or empty is the default. Refused unless above 0. */
export function spendCapOf(env: Env): Record<ChainName, bigint> {
  const one = (chain: ChainName, name: string, unit: string): bigint => {
    const v = env[name]?.trim();
    if (!v) return SPEND_CAP_DEFAULT[chain];
    const wei = /^\d+(\.\d{1,18})?$/.test(v) ? parseEther(v) : 0n;
    if (wei <= 0n) throw new Error(`${name} "${v}" is not an amount of ${unit} above 0 (e.g. ${chain === "base" ? "0.01" : "0.4"}); nothing sent`);
    return wei;
  };
  return { base: one("base", "OPS_KEEPER_SPEND_CAP_BASE", "ETH"), bittensor: one("bittensor", "OPS_KEEPER_SPEND_CAP_BITTENSOR", "TAO") };
}

/** The web's own entry for deployment `name` (web/src/lib/cascade/deployments.json): its batchMaxWaitS and usdcDelivery,
 * the values the site reads. Undefined before the entry exists (Task 67 adds v3.2's). */
export function webEntry(name: string, path: URL | string = WEB_DEPLOYMENTS): { batchMaxWaitS?: unknown; usdcDelivery?: unknown } | undefined {
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, "utf8")) as Record<string, { batchMaxWaitS?: unknown; usdcDelivery?: unknown }>)[name];
}

/** The longest a batch with entries waits: the web's deployments.json batchMaxWaitS for the deployment when it has one,
 * else what `pnpm ops web-config` gives the site (NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S, the launch cadence's: 24 h).
 * One value, read by the keeper and the web alike (T43a's review M2; pinned at Task 67). */
export function batchMaxWaitOf(entry: { batchMaxWaitS?: unknown } | undefined): number {
  const v = entry?.batchMaxWaitS;
  if (v === undefined) return CADENCE.launch.closeMaxWaitS;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`deployments.json's batchMaxWaitS (${String(v)}) is not a number of seconds; nothing read`);
  return v;
}

/** The web's usdcDelivery (web/src/lib/cascade/config.ts usdcDeliveryOn): absent or true is on, anything else off. */
export const usdcDeliveryOf = (entry: { usdcDelivery?: unknown } | undefined): boolean => entry?.usdcDelivery === undefined || entry.usdcDelivery === true;

/** The for-life getters (Task 46b's report §6, list B), by step: each one's immutable or constant, from the plan. */
const FOR_LIFE: Partial<Record<V32StepId, string[]>> = {
  // Task 65: EXIT_GAS_RESERVE (through the lens), the keeper's own payout gas rule's (core/v32/payout.ts): a vault that
  // reads otherwise stops the keeper before any payout
  vault: ["launchChain", "MS_PER_BLOCK", "DOMAIN_SEPARATOR", "STAMP_TYPEHASH", "EXIT_GAS_RESERVE"],
  vaultLens: ["target"],
  doorLens: ["target", "DOMAIN_SEPARATOR", "STAMP_TYPEHASH"],
  frontDoor: ["vault", "vaultChain", "treasury", "asset", "usdc", "MS_PER_BLOCK"],
  staker: ["frontDoor", "tao", "usdc"],
  oracle: ["tao", "usdc", "weth", "taoWethPool", "wethUsdcPool"],
  // merge 7b (R4): the lane's inbound gas model in both its copies, the Bittensor adapter's (deliverParked's requirement)
  // and the Base adapter's own (what CCIP gives a delivery), each the plan's one setting
  bitAdapter: ["treasury", "maxMessageValue", "inboundGasBase", "inboundGasPerEntry"],
  baseAdapter: ["treasury", "maxMessageValue", "minSendAmount", "gasBase", "gasPerEntry"],
};

const nameOf = (id: V32StepId) => CONTRACTS_V32[id].contract.split(":")[1];
const RETURNS = ["address", "uint256", "uint64", "bytes32", "bool"] as const;

/** Each for-life getter's value as the plan sets it, read where it is served (a moved getter through its lens), with the
 * type the frozen build gives it. */
function forLifeValues(plan: PlanV32, build: BuildV32, chainIds: Record<ChainName, number>): ForLifeValue[] {
  const out: ForLifeValue[] = [];
  const abiOf = (id: V32StepId): Abi => (id === "vault" ? build.vaultAbi : build.contracts[nameOf(id)].abi);
  for (const [id, fns] of Object.entries(FOR_LIFE) as [V32StepId, string[]][]) {
    const step = plan.steps.find((s) => s.id === id);
    if (!step) throw new Error(`the plan has no ${id}; nothing built`);
    const values: Record<string, unknown> = { ...immutableValuesV32(plan, id, chainIds), STAMP_TYPEHASH: STAMP_TYPEHASH_V32, ...(id === "vault" ? { EXIT_GAS_RESERVE } : {}) };
    if (id === "doorLens") values.DOMAIN_SEPARATOR = domainSeparatorV32(chainIds.base, plan.addresses.frontDoor);
    if (id === "vault" || id === "frontDoor") values.MS_PER_BLOCK = MS_PER_BLOCK_PINS[step.chain];
    for (const fn of fns) {
      // the vault's moved getters through its lens (routeOf over the frozen ABIs, Task 43a's rule)
      let at: V32StepId = id;
      if (id === "vault") at = routeOf(build.vaultAbi, build.contracts.CascadeVaultLens.abi, fn, "vault") === "lens" ? "vaultLens" : "vault";
      const getter = gettersNamed(abiOf(at), fn).find((f: AbiFunction) => f.inputs.length === 0 && !REVERTING_STUBS.includes(f.name));
      if (!getter) throw new Error(`the frozen build's ${nameOf(at)} has no getter ${fn}(); nothing built`);
      const type = getter.outputs[0].type.startsWith("contract ") ? "address" : getter.outputs[0].type;
      const returns = (RETURNS as readonly string[]).includes(type) ? (type as ForLifeValue["returns"]) : type.startsWith("uint") ? "uint256" : undefined;
      if (!returns) throw new Error(`${nameOf(at)}.${fn}() returns ${type}, which the for-life list can't compare; nothing built`);
      const want = values[fn];
      if (want === undefined) throw new Error(`the plan gives no value for ${nameOf(id)}'s ${fn}; nothing built`);
      out.push({ chain: step.chain, contract: nameOf(at), address: getAddress(plan.addresses[at]), fn, returns, want: typeof want === "string" ? want : String(want) });
    }
  }
  return out;
}

/** The oracle's two pools (its taoWethPool and wethUsdcPool, from the plan), each with the fee tier the plan's route 0
 * buys through it (USDC -fee0-> WETH -fee1-> TAO, over the oracle's own tokens): a pool's fee() is immutable. */
function forLifePools(plan: PlanV32): ForLifePool[] {
  const [taoWethPool, wethUsdcPool, tao, weth, usdc] = (plan.steps.find((s) => s.id === "oracle")?.args ?? []) as Address[];
  const route = (plan.steps.find((s) => s.id === "staker")?.args[0] as { route0?: { buyPath?: Hex } } | undefined)?.route0;
  const p = route?.buyPath?.slice(2) ?? "";
  if (!taoWethPool || !wethUsdcPool || p.length !== 132) throw new Error("the plan has no oracle pools or no route 0 buy path to read their fee tiers from; nothing built");
  const tokens = [p.slice(0, 40), p.slice(46, 86), p.slice(92, 132)].map((t) => getAddress(`0x${t}`));
  if (![usdc, weth, tao].every((t, i) => t !== undefined && getAddress(t) === tokens[i])) {
    throw new Error("the plan's route 0 buy path is not USDC, WETH, TAO, the oracle's tokens, so it gives no fee tier for its pools; nothing built");
  }
  return [
    { pair: "WETH/USDC", address: getAddress(wethUsdcPool), fee: Number.parseInt(p.slice(40, 46), 16) },
    { pair: "TAO/WETH", address: getAddress(taoWethPool), fee: Number.parseInt(p.slice(86, 92), 16) },
  ];
}

/** The vault's creation time, for the deployment's vaultCreatedAt: its create's block time on Bittensor (the record's
 * done.vault.block), read once when the deployment is built (Task 50b's config-from-record). An RPC that has no such
 * block (a pruned node) is refused. */
export async function vaultCreatedAtOf(rpc: Rpc, rec: DeploymentRecordV32): Promise<number> {
  const block = rec.done.vault?.block;
  if (block === undefined) throw new Error("the record has no block for the vault's creation: run deploy to finish it; nothing built");
  const b = (await rpc.request("bittensor", "eth_getBlockByNumber", [numberToHex(block), false])) as { timestamp: Hex } | null;
  if (!b) throw new Error(`Bittensor has no block ${block} (the vault's creation): use an RPC that keeps history (archive.chain.opentensor.ai); nothing built`);
  return hexToNumber(b.timestamp);
}

/** Every create's runtime code, as the frozen build deploys it from the plan, by its hash (metadata stripped). */
function forLifeCode(plan: PlanV32, build: BuildV32, chainIds: Record<ChainName, number>): ForLifeCode[] {
  return (["bittensor", "base"] as const).flatMap((chain) =>
    NONCE_PLAN[chain].map((id) => {
      const hash = codeHashOf(expectedRuntimeV32(build, plan, id, chainIds));
      if (!hash) throw new Error(`the frozen build's ${nameOf(id)} ends in no metadata tail; nothing built`);
      return { chain, contract: nameOf(id), address: getAddress(plan.addresses[id]), codeHash: hash };
    }),
  );
}

/** The v3.2 deployment the keeper runs on, from its record (its plan, its creates' blocks, its frozen build), the
 * deployment's name and chain ids, the vault's creation time (vaultCreatedAtOf), the environment
 * (OPS_PAYOUT_TOPUP_MAX) and the web's deployments.json entry. Never reads verify.ok. Refused when the record lacks a
 * creation block or what it builds is not a usable deployment. */
export function deploymentFromRecordV32(
  rec: DeploymentRecordV32,
  o: {
    name: string;
    chainIds: Record<ChainName, number>;
    vaultCreatedAt: number;
    env: Env;
    buildsDir?: string;
    build?: BuildV32;
    web?: { batchMaxWaitS?: unknown; usdcDelivery?: unknown } | null;
  },
): DeploymentV32 {
  const plan = rec.plan;
  const a = plan.addresses;
  const block = (id: "bitAdapter" | "baseAdapter") => {
    const b = rec.done[id]?.block;
    if (b === undefined) throw new Error(`the record has no block for the ${id === "bitAdapter" ? "Bittensor" : "Base"} adapter's creation, where the keeper's log scans start: run deploy to finish it; nothing built`);
    return BigInt(b);
  };
  const build = o.build ?? loadBuildV32(rec.build, o.buildsDir);
  const vaultParams = plan.steps.find((s) => s.id === "vault")?.args[0] as { launchChain: bigint } | undefined;
  const alphaVault = plan.steps.find((s) => s.id === "bitAdapter")?.args[1] as Address | undefined;
  if (!vaultParams || !alphaVault) throw new Error("the plan has no vault or Bittensor adapter step; nothing built");
  const web = o.web === undefined ? webEntry(o.name) : (o.web ?? undefined);
  const refundFeeMax = parkRefundFeeMaxOf(o.env);
  const reexecAuto = reexecAutoOf(o.env);
  const d: DeploymentV32 = {
    version: "v3.2",
    name: o.name,
    chainIds: o.chainIds,
    launchChain: BigInt(vaultParams.launchChain),
    addresses: {
      vault: a.vault,
      vaultLens: a.vaultLens,
      frontDoor: a.frontDoor,
      doorLens: a.doorLens,
      bitAdapter: a.bitAdapter,
      baseAdapter: a.baseAdapter,
      staker: a.staker,
      oracle: a.oracle,
    },
    keeper: getAddress(plan.roles.keeper),
    vaultColdkey: plan.vaultColdkey,
    vaultCreatedAt: o.vaultCreatedAt,
    startBlocks: { bittensor: block("bitAdapter"), base: block("baseAdapter") },
    batchMaxWaitS: batchMaxWaitOf(web),
    usdcDelivery: usdcDeliveryOf(web),
    payoutTopUpMax: payoutTopUpMax(o.env),
    spendCap: spendCapOf(o.env),
    alphaVault: getAddress(alphaVault),
    quoterV2: BASE_V3.QUOTER_V2,
    ethUsdcPath: encodePacked(["address", "uint24", "address"], [BASE_V3.WETH, 500, BASE_V3.USDC]) as Hex,
    offRamps: { base: LIVE.base.OFFRAMP, bittensor: LIVE.bittensor.OFFRAMP },
    // Task 52: where the park job and the FAILURE re-execution rebuild a message from (each source OnRamp's
    // CCIPMessageSent), and each lane's selectors
    onRamps: { base: LIVE.base.ONRAMP, bittensor: LIVE.bittensor.ONRAMP },
    selectors: { base: LIVE.base.SELECTOR, bittensor: LIVE.bittensor.SELECTOR },
    ...(refundFeeMax !== undefined ? { parkRefundFeeMax: refundFeeMax } : {}),
    // Task 52 fix round 1: off unless OPS_REEXEC_AUTO=on (the founder's ruling)
    ...(reexecAuto !== undefined ? { reexecAuto } : {}),
    stakingPrecompile: PRECOMPILE.staking,
    forLife: { values: forLifeValues(plan, build, o.chainIds), code: forLifeCode(plan, build, o.chainIds), pools: forLifePools(plan) },
    // R4 (D-M2): the pairs pnpm ops add-pair wrote into the record, each scanned from its adapters' creation blocks
    ...(rec.pairs?.length
      ? { pairs: rec.pairs.map((p) => ({ baseAdapter: getAddress(p.baseAdapter), bitAdapter: getAddress(p.bitAdapter), startBlocks: { base: BigInt(p.blocks.base), bittensor: BigInt(p.blocks.bittensor) } })) }
      : {}),
  };
  const problems = deploymentProblems(d);
  if (problems.length) throw new Error(`the v3.2 deployment built from the record is not usable: ${problems.join("; ")}; nothing built`);
  return d;
}
