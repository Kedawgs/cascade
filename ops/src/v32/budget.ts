import { type Address, decodeFunctionResult, encodeFunctionData, formatEther, formatGwei, type Hex, hexToBigInt } from "viem";
import { cardinalityNeeded, cardinalitySteps, GAS_PER_SLOT, gasLimitFor, maxSlotsPerTx, ORACLE_POOLS, readPool } from "../cardinality.ts";
import type { ChainName } from "../config.ts";
import { closeValue } from "../keeper/core/actions.ts";
import { blockTimeOf } from "../keeper/core/blocktime.ts";
import { chainLabel, unit } from "../keeper/core/errors.ts";
import { SPEND_CAP_DEFAULT } from "../keeper/deployment-v32.ts";
import { createRpc, gasPriceOf, type Rpc } from "../rpc.ts";
import { BUILDS_DIR, type BuildV32, freezeBuildV32, loadBuildV32 } from "./build.ts";
import { BASE_L1_ALLOWANCE, type DeploymentRecordV32, fundingNeedFor, gasCeiling, loadRecordV32For } from "./deploy.ts";
import type { V32StepId } from "./plan.ts";
import { FUNDING_V32, V32_ENV, WRITE_OFF_EXECUTE_GAS } from "./settings.ts";

// `pnpm ops budget` for v3.2 (the off-chain report's concern 6, ahead of Task 66 step 4: the fresh deployer keystores
// "funded with the plan's budget and margin", and the relayer). It prices, per chain, at the gas prices read now from
// public RPCs: the deployer's creates (their gas as the rehearsal measured it on the forks, and deploy --v32's own funding
// check, the creates' ceilings at twice the price, which a deployer must pass), the founder's steps after the creates (the
// funding, the treasury's redeem origin, and the settings the rehearsal ran from the sign page), the oracle pools'
// cardinality (nothing while both hold the oracle's minimum), and the relayer's stamps. Every amount carries the margin.
// It reads only; it sends nothing. v3-launch's budget (budget.ts) is unchanged.

/** The margin on every amount, in percent: v3-launch's budget's 30% (budget.ts ceil13), for a gas price that moves
 * between the budget and the sends. */
export const MARGIN_PCT_V32 = 30n;

/** Who sends a founder step: any account the founder holds (the funding: runbook 3.2's `--from`), or a role of the plan. */
export type FounderAccount = "funder" | "treasury" | "owner" | "guardian";

export interface FounderStep {
  account: FounderAccount;
  chain: ChainName;
  label: string;
  gas: bigint;
  /** Why the gas is not the rehearsal's measurement, when it isn't. */
  note?: string;
  /** The gas limit its file sets, when it sets one (R6, claim C: a write-off's execute): held as it is, never a wallet's
   * estimate and a quarter. */
  limit?: bigint;
  /** An emergency step the rehearsal practised (the guardian's pause and disable, the owner's unpause), not a launch
   * step: its gas is still counted, so the account can run the drill (the review of 99d4b07). */
  drill?: true;
  /** R6b (the R6 carry): a step held only if it is planned (a write-off's execute): priced on its own line, never in the
   * account's share. */
  optional?: true;
}

/** The founder's steps after the creates, each with the gas it used on the forks in the rehearsal of 2026-11-14 on the
 * 61 ms-bound contracts (the rehearsal printed them; its record keeps only the creates' gas): runbook 3.2's funding from a
 * plain account (fundReserve, ForeverMoney's depositLiquid for the cushion's FM-TAO, the cushion's approve and
 * fundCushion), runbook 3.4's treasury redeem origin, and the settings the rehearsal ran from the sign page (runbook 2.6
 * set-keeper on both chains, 7.1 the guardian's pause of the front door and the owner's unpause, 7.6 set-idle-buffer, 7.1
 * the guardian's disable-bridge on both). depositLiquid's is an allowance: the forks stake through a stand-in for
 * Bittensor's staking precompile, whose own cost is not Bittensor's. */
export const FOUNDER_STEPS_V32: readonly FounderStep[] = [
  { account: "funder", chain: "bittensor", label: "fundReserve()", gas: 23_208n },
  { account: "funder", chain: "bittensor", label: "depositLiquid", gas: 500_000n, note: "an allowance: 90,724 on the forks, against a stand-in for Bittensor's staking" },
  { account: "funder", chain: "bittensor", label: "approve", gas: 46_365n },
  { account: "funder", chain: "bittensor", label: "fundCushion", gas: 81_898n },
  { account: "treasury", chain: "bittensor", label: "setRedeemOrigin", gas: 46_215n },
  { account: "owner", chain: "bittensor", label: "setKeeper", gas: 30_639n },
  { account: "owner", chain: "bittensor", label: "setIdleBuffer", gas: 48_556n },
  // R6 (ChatGPT R2 claim C): not a launch step, but the owner's account must be able to send it at once if stake is lost
  {
    account: "owner",
    chain: "bittensor",
    label: "execute(writeOffMissingStake)",
    gas: WRITE_OFF_EXECUTE_GAS,
    limit: WRITE_OFF_EXECUTE_GAS,
    note: "an incident step, not a launch step: its file sets this gas limit, which the account must hold at the gas price up front; only the gas used is paid",
    optional: true,
  },
  { account: "guardian", chain: "bittensor", label: "disableBridge", gas: 54_105n, drill: true },
  { account: "owner", chain: "base", label: "setKeeper", gas: 30_935n },
  { account: "guardian", chain: "base", label: "pause", gas: 49_794n, drill: true },
  { account: "owner", chain: "base", label: "unpause", gas: 25_122n, drill: true },
  { account: "guardian", chain: "base", label: "disableBridge", gas: 53_998n, drill: true },
];

/** The TAO the funding account sends ForeverMoney's depositLiquid for the cushion's FM-TAO: the rehearsal's (rehearse.ts
 * FM_DEPOSIT), the chain's minimum stake on 2026-11-11 (runbook 3.2 step 3), which mints about as much FM-TAO, the 0.001
 * cushion and a spare. */
export const CUSHION_DEPOSIT = 2n * 10n ** 15n;

/** A stamp's gas, an allowance: stampBySig checks a 65-byte signature (ecrecover), reads the owner and writes
 * lastOwnerClose, about 50,000 gas with the transaction's own; no stamp is measured on either chain yet. */
export const STAMP_GAS_ALLOWANCE = 100_000n;
/** The stamp bot relays one stamp every 12 hours on each chain (runbook 7.2, the stamp bot). */
export const STAMPS_PER_DAY = 2n;
/** The days of stamps the relayer is funded for. */
export const RELAYER_DAYS = 30n;
/** Base's L1 data fee on a small call (a stamp, a setting, a pool's growth), which eth_gasPrice leaves out: v3-launch's
 * budget's allowance a transaction (budget.ts L1_PER_TX). A create's is deploy's BASE_L1_ALLOWANCE. */
export const BASE_L1_PER_CALL = 4n * 10n ** 13n;

/** R12a (the ChatGPT r3 DoS scan's item 6): the bridge fee of the largest close, a full 50 + 50 batch, toward Bittensor:
 * an allowance, the 0.0042646 ETH Base's CCIP router quoted on 2026-10-21 for the 7,000,000 gas such a batch asks
 * (SETTINGS_V32_LAUNCH.gas.towardBittensor, 1,300,000 + 57,000 × 100), rounded up (research_notes, cross_chain_rails_v2.md).
 * It moves with TAO/ETH and Bittensor's gas price, which the margin covers; the keeper quotes each close live. */
export const FULL_CLOSE_QUOTE_V32 = 43n * 10n ** 14n;

/** The public RPCs the gas prices and the pools are read from: no key in either. */
export const PUBLIC_RPCS_V32: Record<ChainName, string> = { base: "https://mainnet.base.org", bittensor: "https://lite.chain.opentensor.ai" };
export const publicRpcV32 = (): Rpc => createRpc({ base: { rpcUrl: PUBLIC_RPCS_V32.base }, bittensor: { rpcUrl: PUBLIC_RPCS_V32.bittensor } });

/** What the budget is computed from. */
export interface BudgetInputsV32 {
  /** The rehearsal record, its build and when it was rehearsed. */
  path: string;
  buildHash: Hex;
  rehearsedAt: string;
  /** Each create of the rehearsed plan, in its order: its gas on the forks and its ceiling (deploy --v32's gasCeiling). */
  creates: { id: V32StepId; chain: ChainName; gasUsed: bigint; ceiling: bigint }[];
  roles: { owner: Address; guardian: Address; treasury: Address };
  /** Each chain's gas price now (eth_gasPrice) and where it was read. */
  gasPrice: Record<ChainName, bigint>;
  priceFrom: Record<ChainName, string>;
  /** The oracle's two pools: slots in use and reserved, and the cardinalityNext values that grow each to the target
   * (none when it reserves enough). */
  pools: { name: string; address: Address; cardinality: number; next: number; steps: number[] }[];
  /** The rehearsed oracle's MIN_CARDINALITY (frozenMinCardinality), or what Base's block time needs when that is more. */
  cardinalityTarget: number;
  /** What the founder must know before trusting the figures: the checkout's build not the rehearsed one (checkoutWarnings). */
  warnings: string[];
  /** R12a: the keeper's 24 h spend cap on Base, in wei (OPS_KEEPER_SPEND_CAP_BASE as the CLI reads it, else the launch's
   * SPEND_CAP_DEFAULT), what it may spend there in a day beside the float a close sends. */
  keeperSpendCap: bigint;
}

export interface ChainBudgetV32 {
  gasPrice: bigint;
  /** The deployer: its creates' measured gas and cost, deploy --v32's funding check (their ceilings at twice the price,
   * and Base's L1 allowance), and what to send it: the larger, with the margin, rounded up. */
  deployer: { creates: number; gasUsed: bigint; spent: bigint; ceiling: bigint; deployNeed: bigint; send: bigint };
  /** Each founder account's steps on this chain: their gas used, the gas limits a wallet sends them with (a quarter more),
   * what it must hold for them (those limits at twice the price, as a wallet checks, with the margin, and the TAO it
   * sends), and that TAO alone. */
  founder: {
    account: FounderAccount;
    address?: Address;
    steps: FounderStep[];
    gas: bigint;
    limit: bigint;
    need: bigint;
    value: bigint;
    /** R6b: its optional steps (a write-off's execute), priced apart: their gas limits, and their need with the margin */
    optional?: { steps: FounderStep[]; limit: bigint; need: bigint };
  }[];
  /** The pools' growth (Base's): its transactions, their gas, their gas limits, and its cost at the limits at twice the
   * price, with the margin. */
  cardinality: { txs: number; gas: bigint; limit: bigint; need: bigint };
  /** The relayer: its stamps for RELAYER_DAYS, their gas, its need with the margin, and what to send it. */
  relayer: { stamps: bigint; gas: bigint; need: bigint; send: bigint };
  /** R12a, Base only: the keeper's ETH, the float its close of a full 50 + 50 batch sends (closeValue of
   * FULL_CLOSE_QUOTE_V32: three quotes) beside its 24 h spend cap, with the margin, and what to send it. On Bittensor its
   * TAO is runbook 2.2's (one claim's up-front fee and a day of payouts and stakes), not priced here. */
  keeper?: { quote: bigint; float: bigint; cap: bigint; need: bigint; send: bigint };
}

export interface BudgetV32 {
  inputs: BudgetInputsV32;
  chains: Record<ChainName, ChainBudgetV32>;
}

const CHAINS: readonly ChainName[] = ["bittensor", "base"];
/** What a send is rounded up to: 0.001 TAO, 0.0001 ETH (v3-launch's budget's). */
const SEND_STEP: Record<ChainName, bigint> = { bittensor: 10n ** 15n, base: 10n ** 14n };
const withMargin = (x: bigint) => (x * (100n + MARGIN_PCT_V32) + 99n) / 100n;
const roundUp = (x: bigint, step: bigint) => ((x + step - 1n) / step) * step;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const sum = (xs: bigint[]) => xs.reduce((t, x) => t + x, 0n);
/** Base's L1 fee allowance for `calls` small calls; none on Bittensor. */
const l1For = (chain: ChainName, calls: bigint) => (chain === "base" ? calls * BASE_L1_PER_CALL : 0n);
/** The gas limit a wallet sends a call of `gas` with: a quarter more, rounded up (ops' own sends pad so, stamp.ts). */
const walletLimit = (gas: bigint) => (gas * 5n + 3n) / 4n;

/** Why a rehearsal record can't price the live deployment, or nothing when it can: the rehearsal passed (its build named
 * as rehearsed, and that build the record's), its plan not void, its verify passed, and every create done with its gas
 * measured, none pending. */
export function unfinishedRehearsalV32(rec: DeploymentRecordV32): string[] {
  const out: string[] = [];
  if (!rec.rehearsed) out.push("it names no rehearsed build (pnpm ops rehearse --v32 writes it once everything passed)");
  if (rec.void) out.push(`its plan is void (${rec.void.reason})`);
  if (!rec.verify) out.push("it was never verified");
  else if (!rec.verify.ok) out.push("its verify failed");
  const unmeasured = rec.plan.steps.filter((s) => rec.done[s.id]?.gasUsed === undefined).map((s) => s.id);
  if (unmeasured.length) out.push(`${unmeasured.length} create${unmeasured.length === 1 ? "" : "s"} with no measured gas (${unmeasured.join(", ")})`);
  if (rec.pending) out.push("a create still pending");
  if (rec.rehearsed && rec.rehearsed.buildHash.toLowerCase() !== rec.build.hash.toLowerCase()) out.push("its build is not the one it names as rehearsed");
  return out;
}

/** A scratch address the frozen oracle's runtime is placed at for one eth_call: no contract lives there. */
const SCRATCH: Address = "0x00000000000000000000000000000000000c0de1";

/** The rehearsed oracle's own MIN_CARDINALITY (the review of 99d4b07): its frozen runtime, run on Base by an eth_call
 * with a code override at a scratch address (the constant has no slot to read, and the frozen build keeps no AST), so the
 * pools are sized for the oracle deploy --v32 will send, never the checkout's. Throws, naming why, when Base can't run it
 * (an RPC that ignores code overrides answers nothing). */
export async function frozenMinCardinality(rpc: Rpc, build: BuildV32): Promise<number> {
  const oracle = build.contracts.CascadeTwapOracle;
  if (!oracle) throw new Error("the rehearsed build has no CascadeTwapOracle; nothing printed");
  const data = encodeFunctionData({ abi: oracle.abi, functionName: "MIN_CARDINALITY" });
  let value: number;
  try {
    const out = (await rpc.request("base", "eth_call", [{ to: SCRATCH, data }, "latest", { [SCRATCH]: { code: oracle.deployedBytecode.object } }])) as Hex;
    value = Number(decodeFunctionResult({ abi: oracle.abi, functionName: "MIN_CARDINALITY", data: out }));
  } catch (e) {
    throw new Error(
      `could not read the rehearsed oracle's MIN_CARDINALITY (its frozen runtime, run by an eth_call with a code override on Base: ${(e as Error).message.split("\n")[0]}); nothing printed`,
    );
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) throw new Error(`the rehearsed oracle's MIN_CARDINALITY reads ${value}, not a uint16 above 0; nothing printed`);
  return value;
}

/** What differs between this checkout's contracts/out and the rehearsed build (the review of 99d4b07): a warning naming
 * each contract whose code differs, and the compiler or the link set, since deploy --v32 sends only the rehearsed build
 * and refuses another; none when they match. A checkout whose build can't be read is said so. */
export async function checkoutWarnings(contractsDir: string, rehearsed: BuildV32): Promise<string[]> {
  const tail = "deploy --v32 sends only the rehearsed build, so it would refuse this checkout; build the rehearsed contracts, or rehearse again. The figures below are the rehearsed build's.";
  let here: BuildV32;
  try {
    here = (await freezeBuildV32(contractsDir)).build;
  } catch (e) {
    return [`this checkout's contracts/out could not be read to compare it with the rehearsed build (${(e as Error).message.split("\n")[0]}): ${tail}`];
  }
  const names = [...new Set([...Object.keys(here.contracts), ...Object.keys(rehearsed.contracts)])].sort().filter((name) => {
    const [a, b] = [here.contracts[name], rehearsed.contracts[name]];
    return !a || !b || a.bytecode.object !== b.bytecode.object || a.deployedBytecode.object !== b.deployedBytecode.object;
  });
  const diff = [
    ...names,
    ...(JSON.stringify(here.compiler) !== JSON.stringify(rehearsed.compiler) ? ["the compiler"] : []),
    ...(JSON.stringify(here.links) !== JSON.stringify(rehearsed.links) ? ["the link set"] : []),
  ];
  return diff.length ? [`this checkout's contracts/out is not the build the rehearsal deployed (${diff.join(", ")} ${diff.length === 1 ? "differs" : "differ"}): ${tail}`] : [];
}

/** The budget's inputs: the record's creates, with their measured gas and their ceilings from its frozen build; the
 * plan's roles; and, from `rpc` (public RPCs), each chain's gas price and the oracle pools' slots against the target (the
 * rehearsed oracle's MIN_CARDINALITY, or what Base's block time needs when that is more); and a warning when this
 * checkout's build is not the rehearsed one. A record that can't price the deployment is refused before anything is read. */
export async function gatherBudgetInputsV32(
  rpc: Rpc,
  rec: DeploymentRecordV32,
  o: { path: string; contractsDir: string; buildsDir?: string; priceFrom?: Record<ChainName, string>; spendCap?: bigint },
): Promise<BudgetInputsV32> {
  const unfinished = unfinishedRehearsalV32(rec);
  if (unfinished.length) throw new Error(`the v3.2 rehearsal record ${o.path} can't price the deployment (${unfinished.join("; ")}): run pnpm ops rehearse --v32 again; nothing read`);
  const build = loadBuildV32(rec.build, o.buildsDir ?? BUILDS_DIR);
  const creates = rec.plan.steps.map((s) => ({ id: s.id, chain: s.chain, gasUsed: rec.done[s.id]!.gasUsed, ceiling: gasCeiling(build, s) }));
  const gasPrice = { bittensor: await gasPriceOf(rpc, "bittensor"), base: await gasPriceOf(rpc, "base") };
  const target = Math.max(await frozenMinCardinality(rpc, build), cardinalityNeeded(await blockTimeOf(rpc, "base")));
  const latest = (await rpc.request("base", "eth_getBlockByNumber", ["latest", false])) as { gasLimit?: Hex } | null;
  if (!latest?.gasLimit) throw new Error("Base's latest block gave no gas limit: the pools' growth can't be sized; nothing printed");
  const maxStep = maxSlotsPerTx(Number(hexToBigInt(latest.gasLimit)));
  const pools: BudgetInputsV32["pools"] = [];
  for (const p of ORACLE_POOLS) {
    const s = await readPool({ rpc }, p.address);
    pools.push({ name: p.name, address: p.address, cardinality: s.cardinality, next: s.next, steps: cardinalitySteps(s.next, target, maxStep) });
  }
  const { owner, guardian, treasury } = rec.plan.roles;
  return {
    path: o.path,
    buildHash: rec.build.hash,
    rehearsedAt: rec.rehearsed!.at,
    creates,
    roles: { owner, guardian, treasury },
    gasPrice,
    priceFrom: o.priceFrom ?? PUBLIC_RPCS_V32,
    pools,
    cardinalityTarget: target,
    warnings: await checkoutWarnings(o.contractsDir, build),
    keeperSpendCap: o.spendCap ?? SPEND_CAP_DEFAULT.base,
  };
}

/** The budget: per chain, the deployer, the founder's accounts, the pools' growth and the relayer, each with the margin. */
export function computeBudgetV32(i: BudgetInputsV32): BudgetV32 {
  const chainBudget = (chain: ChainName): ChainBudgetV32 => {
    const price = i.gasPrice[chain];
    const creates = i.creates.filter((c) => c.chain === chain);
    const gasUsed = sum(creates.map((c) => c.gasUsed));
    const ceiling = sum(creates.map((c) => c.ceiling));
    const createL1 = chain === "base" ? BigInt(creates.length) * BASE_L1_ALLOWANCE : 0n;
    const spent = gasUsed * price + createL1;
    const deployNeed = fundingNeedFor(ceiling, creates.length, chain, price);
    const deployer = { creates: creates.length, gasUsed, spent, ceiling, deployNeed, send: roundUp(withMargin(max(spent, deployNeed)), SEND_STEP[chain]) };
    const founder = (["funder", "treasury", "owner", "guardian"] as const).flatMap((account) => {
      const all = FOUNDER_STEPS_V32.filter((s) => s.chain === chain && s.account === account);
      if (!all.length) return [];
      // R6b (the R6 carry): an optional step (a write-off's execute) is priced on its own line, never in the share
      const steps = all.filter((s) => !s.optional);
      const extra = all.filter((s) => s.optional);
      const optionalLimit = sum(extra.map((s) => s.limit ?? walletLimit(s.gas)));
      const optional = extra.length ? { optional: { steps: extra, limit: optionalLimit, need: withMargin(optionalLimit * price * 2n + l1For(chain, BigInt(extra.length))) } } : {};
      const gas = sum(steps.map((s) => s.gas));
      // as a wallet checks it (the review of 99d4b07, M5; the deployer's sizing): each call's limit, its gas and a quarter,
      // at its max fee, about twice the price
      const limit = sum(steps.map((s) => s.limit ?? walletLimit(s.gas)));
      // the funding's TAO: the reserve's, and depositLiquid's for the cushion's FM-TAO
      const value = chain === "bittensor" && account === "funder" ? FUNDING_V32.adapterReserve + CUSHION_DEPOSIT : 0n;
      const need = withMargin(limit * price * 2n + l1For(chain, BigInt(steps.length))) + value;
      return [{ account, ...(account === "funder" ? {} : { address: i.roles[account] }), steps, gas, limit, need, value, ...optional }];
    });
    let txs = 0;
    let slotsGas = 0n;
    let limit = 0n;
    if (chain === "base") {
      for (const p of i.pools) {
        let from = p.next;
        for (const next of p.steps) {
          txs += 1;
          slotsGas += BigInt((next - from) * GAS_PER_SLOT);
          limit += BigInt(gasLimitFor(next - from));
          from = next;
        }
      }
    }
    // their gas limits at twice the price, as a wallet checks them (as the founder steps)
    const cardinality = { txs, gas: slotsGas, limit, need: txs ? withMargin(limit * price * 2n + l1For(chain, BigInt(txs))) : 0n };
    const stamps = STAMPS_PER_DAY * RELAYER_DAYS;
    const stampGas = stamps * STAMP_GAS_ALLOWANCE;
    const relayerNeed = withMargin(stampGas * price + l1For(chain, stamps));
    // R12a: the keeper on Base holds a full batch's float beside a day's spending; a close's gas is inside the cap
    const float = closeValue(FULL_CLOSE_QUOTE_V32);
    const keeperNeed = withMargin(float + i.keeperSpendCap);
    const keeper = chain === "base" ? { keeper: { quote: FULL_CLOSE_QUOTE_V32, float, cap: i.keeperSpendCap, need: keeperNeed, send: roundUp(keeperNeed, SEND_STEP.base) } } : {};
    return { gasPrice: price, deployer, founder, cardinality, relayer: { stamps, gas: stampGas, need: relayerNeed, send: roundUp(relayerNeed, SEND_STEP[chain]) }, ...keeper };
  };
  return { inputs: i, chains: { bittensor: chainBudget("bittensor"), base: chainBudget("base") } };
}

const n = (x: bigint | number) => x.toLocaleString("en-US");
const keystoreOf = (chain: ChainName) => (chain === "base" ? V32_ENV.baseKeystore : V32_ENV.bittensorKeystore);
const WHO: Record<FounderAccount, string> = { funder: "the funding account", treasury: "the treasury", owner: "the owner", guardian: "the guardian" };

/** The budget in words, per chain: the gas price used and where it was read, the deployer's gas and what deploy --v32
 * checks, each founder account's steps, the vault's ED_RESERVE (Bittensor), the pools' growth (Base), the relayer; then
 * the sends. */
export function formatBudgetV32(b: BudgetV32): string[] {
  const i = b.inputs;
  const lines = [
    `The v3.2 deployment's budget, from the rehearsal record ${i.path} (build ${i.buildHash}, rehearsed ${i.rehearsedAt}), at the gas prices read now from public RPCs, each amount with a ${MARGIN_PCT_V32}% margin:`,
    ...i.warnings.map((w) => `Warning: ${w}`),
  ];
  for (const chain of CHAINS) {
    const c = b.chains[chain];
    const u = unit(chain);
    const base = chain === "base";
    const d = c.deployer;
    lines.push(
      `${chainLabel(chain)}: gas price ${formatGwei(c.gasPrice)} gwei (eth_gasPrice at ${i.priceFrom[chain]})`,
      `  The deployer, a fresh key (${keystoreOf(chain)}): its ${d.creates} creates used ${n(d.gasUsed)} gas in the rehearsal, ${formatEther(d.spent)} ${u} at that price${base ? ` with ${formatEther(BASE_L1_ALLOWANCE)} ETH a create for Base's L1 fee` : ""}. deploy --v32 refuses to start unless it holds the creates' ceilings, ${n(d.ceiling)} gas, at twice the price${base ? ", and that L1 allowance" : ""}: ${formatEther(d.deployNeed)} ${u}. Send it ${formatEther(d.send)} ${u}.`,
      "  The founder's steps after the creates (the gas each used in the rehearsal; a drill is an emergency step it practised, not a launch step; each account holds its own share):",
    );
    for (const f of c.founder) {
      const label = (s: FounderStep) => `${s.label}${s.drill ? " (a drill)" : ""}`;
      // one step: its label, then its gas once
      const steps =
        f.steps.length === 1
          ? `${label(f.steps[0])}${f.steps[0].note ? ` (${f.steps[0].note})` : ""}, `
          : `${f.steps.map((s) => `${label(s)} ${n(s.gas)}${s.note ? ` (${s.note})` : ""}`).join(", ")}: `;
      const who = f.account === "funder" ? `${WHO.funder} (any account you hold; runbook 3.2)` : `${WHO[f.account]} ${f.address}`;
      const gas = `${steps}${n(f.gas)} gas, ${n(f.limit)} as wallet limits (a quarter more) at twice the price: ${formatEther(f.need - f.value)} ${u} with the margin`;
      if (f.value > 0n) {
        lines.push(
          `    ${who}: ${gas}, and the ${formatEther(f.value)} ${u} it sends (${formatEther(FUNDING_V32.adapterReserve)} with fundReserve(), ${formatEther(CUSHION_DEPOSIT)} with depositLiquid, which mints the ${formatEther(FUNDING_V32.adapterCushion)} FM-TAO cushion): about ${formatEther(f.need)} ${u}`,
        );
      } else lines.push(`    ${who}: ${gas}${base ? ` (${formatEther(BASE_L1_PER_CALL)} ETH a call for Base's L1 fee)` : ""}`);
      // R6b (the R6 carry): held only if planned
      if (f.optional) {
        const o = f.optional;
        lines.push(
          `      Only if you plan a write-off: ${o.steps.map((s) => `${label(s)}${s.note ? ` (${s.note})` : ""}`).join(", ")}, ${n(o.limit)} as its gas limit at twice the price: ${formatEther(o.need)} ${u} more with the margin. Hold it then, not now.`,
        );
      }
    }
    if (!base) {
      lines.push(
        `  The vault's ED_RESERVE: ${formatEther(FUNDING_V32.edReserve + FUNDING_V32.existentialDeposit)} TAO by substrate transfer to the vault's account, from a substrate wallet (its own fee beside it).`,
      );
    } else if (c.cardinality.txs === 0) {
      const held = i.pools.map((p, k) => `the ${p.name}${k === 0 ? " holds" : ""} ${n(p.cardinality)}${k === 0 ? " slots" : ""}${p.next > p.cardinality ? ` (growing to ${n(p.next)})` : ""}`).join(", ");
      lines.push(`  The oracle's pools: nothing to grow, so no cost (${held}; the oracle needs ${n(i.cardinalityTarget)}).`);
    } else {
      const k = c.cardinality;
      lines.push(
        `  The oracle's pools: ${k.txs} transaction${k.txs === 1 ? "" : "s"} grow them to ${n(i.cardinalityTarget)} slots (pnpm ops cardinality writes them; any account may send them): ${n(k.gas)} gas, at most ${n(k.limit)} at their gas limits, at twice the price: ${formatEther(k.need)} ETH with the margin.`,
      );
    }
    const r = c.relayer;
    lines.push(
      `  The relayer, a fresh key (OPS_RELAYER_KEYSTORE): ${n(r.stamps)} stamps, one every ${24n / STAMPS_PER_DAY} hours for ${RELAYER_DAYS} days, at ${n(STAMP_GAS_ALLOWANCE)} gas each (an allowance: no stamp is measured yet): ${n(r.gas)} gas, ${formatEther(r.need)} ${u} with the margin${base ? ` (${formatEther(BASE_L1_PER_CALL)} ETH a stamp for Base's L1 fee)` : ""}. Send it ${formatEther(r.send)} ${u}.`,
    );
    // R12a: the keeper's ETH, Base only
    const k = c.keeper;
    if (k) {
      lines.push(
        `  The keeper, its own key (OPS_V32_KEEPER_ADDRESS): a close sends a float of three times its bridge fee quote (the front door sends back what the fee leaves), so a full 50 + 50 batch's, at ${formatEther(k.quote)} ETH a quote (an allowance: Base's CCIP router quoted 0.0042646 ETH for the 7,000,000 gas toward Bittensor such a batch asks, on 2026-10-21; the keeper quotes each close live), needs ${formatEther(k.float)} ETH on hand; beside it, its 24 h spend cap, ${formatEther(k.cap)} ETH (OPS_KEEPER_SPEND_CAP_BASE), what it may spend in a day: ${formatEther(k.float + k.cap)} ETH, ${formatEther(k.need)} ETH with the margin. Send it ${formatEther(k.send)} ETH.`,
      );
    }
  }
  const [bit, base] = [b.chains.bittensor, b.chains.base];
  lines.push(
    "The sends:",
    `  ${formatEther(bit.deployer.send)} TAO to the Bittensor deployer and ${formatEther(base.deployer.send)} ETH on Base to the Base deployer: Task 66 step 4's fresh keys, before pnpm ops deploy --v32 --live`,
    `  ${formatEther(bit.relayer.send)} TAO on Bittensor and ${formatEther(base.relayer.send)} ETH on Base to the relayer`,
    ...(base.keeper ? [`  ${formatEther(base.keeper.send)} ETH on Base to the keeper, its own key (its TAO on Bittensor, about 0.45 TAO: runbook 2.2)`] : []),
  );
  if (base.cardinality.txs > 0) {
    lines.push(`  ${formatEther(base.cardinality.need)} ETH on Base for the pools' growth, from any account, before the deploy (the oracle refuses a pool short of ${n(i.cardinalityTarget)} slots)`);
  }
  lines.push(
    `  After the deploy, the funding it prints: ${formatEther(FUNDING_V32.edReserve + FUNDING_V32.existentialDeposit)} TAO to the vault by substrate transfer, fundReserve() with ${formatEther(FUNDING_V32.adapterReserve)} TAO, and the ${formatEther(FUNDING_V32.adapterCushion)} FM-TAO cushion (approve, then fundCushion) from depositLiquid with ${formatEther(CUSHION_DEPOSIT)} TAO; each founder account above holds its share of the gas`,
  );
  return lines;
}

/** `pnpm ops budget` on a v3.2 deployment: the rehearsal record at `path` (refused with a clear message when there is
 * none, or when it can't price the deployment), its inputs gathered from `rpc` (public RPCs: publicRpcV32), the budget's
 * lines. Reads only. */
export async function budgetCommandV32(rpc: Rpc, o: { path: string; contractsDir: string; buildsDir?: string; spendCap?: bigint }): Promise<string[]> {
  const rec = loadRecordV32For(o.path, false);
  if (!rec) {
    throw new Error(`there is no v3.2 rehearsal record at ${o.path}: run pnpm ops rehearse --v32 first (OPS_DEPLOYMENT=v3.2-launch); the budget prices the deployment from its measured gas; nothing read`);
  }
  return formatBudgetV32(computeBudgetV32(await gatherBudgetInputsV32(rpc, rec, o)));
}
