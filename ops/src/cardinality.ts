import { type Address, encodeFunctionData, type Hex, parseAbi } from "viem";
import { BASE_V3 } from "./config.ts";
import { cadenceOf, type PlanV3 } from "./plan.ts";
import type { Findings } from "./registry.ts";
import { read } from "./rpc.ts";
import type { Ctx } from "./send.ts";

/** CascadeTwapOracle.TWAP_WINDOW (the test checks it against the source). */
export const ORACLE_TWAP_WINDOW_S = 1800;
/** Base makes a block every 2 seconds. */
export const BASE_BLOCK_TIME_S = 2;
/** What the owner grows the TAO/WETH pool to: more than twice what the window needs, so a busy stretch
 * can't empty it. */
export const CARDINALITY_TARGET = 2000;
/** New observation slots per transaction. Each costs about 22,500 gas (a cold storage write): 600 new slots
 * from 600 measured 13,479,008 gas on Base (2026-10-28), and Base refuses any transaction above 16,777,216
 * gas (EIP-7825; 2,000 from 600 in one call needs about 31M and can't be mined). Two steps of 700 would
 * each need about 15.7M, within 6% of the cap: a wallet padding its gas limit would push them over. At
 * 600 a step stays near 13.5M, so from 600 it takes three: 1,200, 1,800, 2,000. */
export const MAX_NEW_SLOTS_PER_TX = 600;
const GAS_PER_SLOT = 22_500;

/** The gas limit to send a step of `newSlots` with: 25,000 a slot (11% over the measured cost) and 100,000
 * more, so a full 600-slot step is 15.1M, under the cap whatever a wallet would pad. */
export const gasLimitFor = (newSlots: number) => newSlots * 25_000 + 100_000;

/** The two pools the oracle reads, as deployed. */
export const ORACLE_POOLS = [
  { name: "TAO/WETH 0.3% pool", address: BASE_V3.TAO_WETH_POOL },
  { name: "WETH/USDC 0.05% pool", address: BASE_V3.WETH_USDC_POOL },
] as const satisfies readonly { name: string; address: Address }[];

export const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
]);

/** Slots a pool needs for `windowS` of history when every block writes an observation: one per block
 * over the window and the newest one (observe(window) reverts "OLD" when the oldest kept observation is
 * younger than the window). 1,800 s on 2-second blocks: 901. */
export const cardinalityNeeded = (windowS = ORACLE_TWAP_WINDOW_S, blockS = BASE_BLOCK_TIME_S) => Math.ceil(windowS / blockS) + 1;

export interface PoolSlots {
  /** observationCardinality: slots in use */
  cardinality: number;
  /** observationCardinalityNext: slots reserved, which the ring grows into as the pool trades */
  next: number;
}

/** A pool with enough slots in use passes; one with enough reserved but not yet in use passes with a
 * note (its history covers the window only once it has grown and traded through them); else a problem. */
export function cardinalityFinding(label: string, s: PoolSlots, need = cardinalityNeeded()): { problem?: string; note?: string } {
  if (s.cardinality >= need) return {};
  if (s.next >= need) {
    return { note: `${label} is growing to ${s.next} observation slots (${s.cardinality} in use): its history reaches the oracle's 30 minutes once it has grown and traded through them` };
  }
  return {
    problem: `${label} has ${s.cardinality} observation slots (cardinalityNext ${s.next}): the oracle's 30-minute window needs ${need} on Base's 2-second blocks, or a delivery can revert; grow it with the transactions from pnpm ops cardinality`,
  };
}

export async function readPool(ctx: Pick<Ctx, "rpc">, pool: Address): Promise<PoolSlots> {
  const s = (await read(ctx.rpc, "base", { address: pool, abi: POOL_ABI, functionName: "slot0" })) as readonly unknown[];
  return { cardinality: Number(s[3]), next: Number(s[4]) };
}

/** Preflight's check of both pools: [label, problem or null]. */
export async function poolProblems(ctx: Pick<Ctx, "rpc">): Promise<[string, string | null][]> {
  const out: [string, string | null][] = [];
  for (const p of ORACLE_POOLS) {
    const f = cardinalityFinding(`the ${p.name}`, await readPool(ctx, p.address));
    out.push([`the ${p.name} (${p.address}) holds 30 minutes of history`, f.problem ?? null]);
  }
  return out;
}

/** verify's check of both pools: a short pool fails a launch and is a warning for a test deployment (which
 * ran with 600 slots); a growing one is a warning either way. */
export async function cardinalityChecks(ctx: Pick<Ctx, "rpc">, plan: PlanV3): Promise<Findings> {
  const out: Findings = { failures: [], warnings: [] };
  const launch = cadenceOf(plan) === "launch";
  for (const p of ORACLE_POOLS) {
    const f = cardinalityFinding(`Base ${p.name} ${p.address}`, await readPool(ctx, p.address));
    if (f.problem) (launch ? out.failures : out.warnings).push(f.problem);
    if (f.note) out.warnings.push(f.note);
  }
  return out;
}

/** The cardinalityNext values to grow through from `next` to `target`, at most `maxStep` new slots each. */
export function cardinalitySteps(next: number, target = CARDINALITY_TARGET, maxStep = MAX_NEW_SLOTS_PER_TX): number[] {
  const out: number[] = [];
  for (let n = next; n < target; ) {
    n = Math.min(n + maxStep, target);
    out.push(n);
  }
  return out;
}

export const cardinalityTxs = (pool: Address, steps: number[]): { to: Address; data: Hex; next: number }[] =>
  steps.map((next) => ({ to: pool, next, data: encodeFunctionData({ abi: POOL_ABI, functionName: "increaseObservationCardinalityNext", args: [next] }) }));

/** `pnpm ops cardinality`: each pool's slots, and for one below the target the exact transactions that
 * grow it, in order. Anyone may send them (the pool's function is permissionless), from any wallet. Reads
 * only; sends nothing. */
export async function cardinalityReport(ctx: Pick<Ctx, "rpc">): Promise<string[]> {
  const lines: string[] = [];
  const need = cardinalityNeeded();
  for (const p of ORACLE_POOLS) {
    const s = await readPool(ctx, p.address);
    const steps = cardinalitySteps(s.next);
    if (!steps.length) {
      lines.push(`The ${p.name} ${p.address}: ${s.cardinality} observation slots (cardinalityNext ${s.next}): enough (the oracle needs ${need}).`);
      continue;
    }
    lines.push(
      `The ${p.name} ${p.address}: ${s.cardinality} observation slots in use, cardinalityNext ${s.next}; the oracle needs ${need}, the target is ${CARDINALITY_TARGET}.`,
      `Base refuses a transaction above 16,777,216 gas and each new slot costs about ${GAS_PER_SLOT.toLocaleString("en-US")}, so send ${steps.length === 1 ? "this transaction" : `these ${steps.length} transactions, in this order,`} from any wallet (no value; anyone may call it):`,
    );
    let from = s.next;
    cardinalityTxs(p.address, steps).forEach((t, i) => {
      const slots = t.next - from;
      lines.push(
        `  ${i + 1}. to ${t.to} data ${t.data}  (increaseObservationCardinalityNext(${t.next}), about ${((slots * GAS_PER_SLOT) / 1e6).toFixed(1)}M gas; gas limit ${gasLimitFor(slots).toLocaleString("en-US")})`,
      );
      from = t.next;
    });
    lines.push(
      `  With Foundry: cast send ${p.address} "increaseObservationCardinalityNext(uint16)" ${steps[0]} --gas-limit ${gasLimitFor(steps[0] - s.next)} --rpc-url <Base RPC> --keystore <your keystore>, then the next value with its own gas limit. Set the gas limit as given: a wallet that pads it could go over Base's cap.`,
      `Then the pool's history grows as it trades; run this again (or pnpm ops preflight) until it reads at least ${need} slots in use.`,
    );
  }
  return lines;
}
