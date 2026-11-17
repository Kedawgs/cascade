import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, encodeFunctionData, getAddress, type Hex, hexToBigInt, parseAbi } from "viem";
import { BASE_V3 } from "./config.ts";
import { blockTimeOf } from "./keeper/core/blocktime.ts";
import { cadenceOf, type PlanV3 } from "./plan.ts";
import type { Findings } from "./registry.ts";
import { read } from "./rpc.ts";
import type { Ctx } from "./send.ts";
import { type NewWalletCall, walletFile, writeWalletFile, wroteLine } from "./wallet.ts";

/** CascadeTwapOracle.TWAP_WINDOW (the test checks it against the source). */
export const ORACLE_TWAP_WINDOW_S = 1800;
/** A Uniswap v3 pool writes at most one observation a second: Oracle.write returns early when its newest observation has
 * the same block.timestamp, and a timestamp is whole seconds, so Base's five blocks a second (200 ms blocks since block
 * 53,556,128) share one. Each slot covers at least a second, however short Base's blocks get. */
export const MIN_OBSERVATION_GAP_S = 1;
/** Base refuses any transaction above 16,777,216 gas (EIP-7825), whatever a block holds. */
export const TX_GAS_CAP = 16_777_216;
/** New observation slots per transaction, at most. Each costs about GAS_PER_SLOT: 600 new slots from 600 measured
 * 13,479,008 gas on Base (2026-10-28). Two steps of 700 would each need about 15.7M, within 6% of TX_GAS_CAP: a wallet
 * padding its gas limit would push them over. Fewer when Base's block gas limit can't hold a full step (maxSlotsPerTx). */
export const MAX_NEW_SLOTS_PER_TX = 600;
/** The gas one new slot costs, about (a cold storage write). */
export const GAS_PER_SLOT = 22_500;

/** The gas limit to send a step of `newSlots` with: 25,000 a slot (11% over the measured cost) and 100,000
 * more, so a full 600-slot step is 15.1M, under the cap whatever a wallet would pad. */
export const gasLimitFor = (newSlots: number) => newSlots * 25_000 + 100_000;

/** The new slots one transaction may take: MAX_NEW_SLOTS_PER_TX, or fewer so that its gas limit fits a block of
 * `blockGasLimit` gas (and TX_GAS_CAP). */
export function maxSlotsPerTx(blockGasLimit: number): number {
  const room = Math.min(TX_GAS_CAP, blockGasLimit) - gasLimitFor(0);
  return Math.max(1, Math.min(MAX_NEW_SLOTS_PER_TX, Math.floor(room / 25_000)));
}

/** The two pools the oracle reads, as deployed. */
export const ORACLE_POOLS = [
  { name: "TAO/WETH 0.3% pool", address: BASE_V3.TAO_WETH_POOL },
  { name: "WETH/USDC 0.05% pool", address: BASE_V3.WETH_USDC_POOL },
] as const satisfies readonly { name: string; address: Address }[];

export const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
]);

/** Slots a pool needs for `windowS` of history when it trades in every block, at `blockS` seconds a block (Base's,
 * measured): one an observation over the window, an observation at most every MIN_OBSERVATION_GAP_S, and the newest
 * (observe(window) reverts "OLD" when the oldest kept observation is younger than the window). 1,800 s on 2-second
 * blocks: 901; on 1-second blocks or shorter: 1,801. */
export const cardinalityNeeded = (blockS: number, windowS = ORACLE_TWAP_WINDOW_S) => Math.ceil(windowS / Math.max(blockS, MIN_OBSERVATION_GAP_S)) + 1;

/** What the pools need now: cardinalityNeeded at Base's block time, measured from two of its headers. */
export const cardinalityNeededNow = async (ctx: Pick<Ctx, "rpc">) => cardinalityNeeded(await blockTimeOf(ctx.rpc, "base"));

interface AstNode {
  nodeType?: string;
  name?: string;
  id?: number;
  constant?: boolean;
  kind?: string;
  value?: unknown;
  /** a number literal's unit (seconds, minutes, ether, …): null when it has none */
  subdenomination?: string | null;
  operator?: string;
  referencedDeclaration?: number;
  leftExpression?: AstNode;
  rightExpression?: AstNode;
  arguments?: AstNode[];
  components?: (AstNode | null)[];
  [k: string]: unknown;
}

/** The built oracle's MIN_CARDINALITY (contracts/out's CascadeTwapOracle, its AST: a constant has no slot or immutable to
 * read), worked out from its declaration: Revision 28 writes it `uint16(TWAP_WINDOW + 1)`, 1,801, which the AST holds as
 * an expression, so a number (with no unit), another constant of the file, + - * /, a cast and parentheses are evaluated
 * (anything else throws). Throws when the build has none, or none ops can evaluate. */
export function oracleMinCardinality(contractsDir: string): number {
  const json = JSON.parse(readFileSync(join(contractsDir, "out", "CascadeTwapOracle.sol", "CascadeTwapOracle.json"), "utf8")) as { ast?: AstNode };
  const found: AstNode[] = [];
  const byId = new Map<number, AstNode>();
  const walk = (n: unknown) => {
    if (Array.isArray(n)) for (const x of n) walk(x);
    else if (n && typeof n === "object") {
      const node = n as AstNode;
      if (node.nodeType === "VariableDeclaration" && node.constant === true) {
        if (typeof node.id === "number") byId.set(node.id, node);
        if (node.name === "MIN_CARDINALITY") found.push(node);
      }
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(json.ast);
  const fail = (why: string): never => {
    throw new Error(`contracts/out's CascadeTwapOracle declares no MIN_CARDINALITY constant ops can read (${why}; forge builds its AST with ast = true)`);
  };
  const evaluate = (e: AstNode | null | undefined, depth = 0): bigint => {
    if (!e || depth > 16) return fail("an expression it can't follow");
    switch (e.nodeType) {
      case "Literal":
        // a unit (30 minutes, 1 ether) multiplies the digits: refused rather than read without it
        if (e.subdenomination) return fail(`the literal ${String(e.value)} ${e.subdenomination}`);
        if (e.kind !== "number" || typeof e.value !== "string" || !/^[\d_]+$/.test(e.value)) return fail(`the literal ${String(e.value)}`);
        return BigInt(e.value.replaceAll("_", ""));
      case "Identifier": {
        const d = e.referencedDeclaration === undefined ? undefined : byId.get(e.referencedDeclaration);
        return d ? evaluate(d.value as AstNode, depth + 1) : fail(`${String(e.name)} is no constant of the file`);
      }
      case "BinaryOperation": {
        const [l, r] = [evaluate(e.leftExpression, depth + 1), evaluate(e.rightExpression, depth + 1)];
        if (e.operator === "+") return l + r;
        if (e.operator === "-") return l - r;
        if (e.operator === "*") return l * r;
        if (e.operator === "/" && r !== 0n) return l / r;
        return fail(`the operator ${String(e.operator)}`);
      }
      case "FunctionCall":
        // a cast, uint16(...): its one argument's value (the declaration's type holds it)
        return e.kind === "typeConversion" && e.arguments?.length === 1 ? evaluate(e.arguments[0], depth + 1) : fail("a call that is not a cast");
      case "TupleExpression":
        return e.components?.length === 1 ? evaluate(e.components[0], depth + 1) : fail("a tuple");
      default:
        return fail(`a ${String(e.nodeType)}`);
    }
  };
  if (found.length !== 1) fail(found.length ? "more than one" : "none");
  const v = Number(evaluate(found[0].value as AstNode));
  if (!Number.isSafeInteger(v) || v <= 0 || v > 65_535) fail(`it reads ${v}, not a uint16 above 0`);
  return v;
}

/** What `pnpm ops cardinality` grows both pools to: the v3.2 oracle's MIN_CARDINALITY (its constructor refuses a pool with
 * fewer slots in use; TWAP_WINDOW + 1, 1,801, since Revision 28), or what the window needs now (`need`) when that is more. */
export const cardinalityTarget = (contractsDir: string, need: number) => Math.max(oracleMinCardinality(contractsDir), need);

export interface PoolSlots {
  /** observationCardinality: slots in use */
  cardinality: number;
  /** observationCardinalityNext: slots reserved, which the ring grows into as the pool trades */
  next: number;
}

/** A pool with enough slots in use passes; one with enough reserved but not yet in use passes with a
 * note (its history covers the window only once it has grown and traded through them); else a problem. */
export function cardinalityFinding(label: string, s: PoolSlots, need: number): { problem?: string; note?: string } {
  if (s.cardinality >= need) return {};
  if (s.next >= need) {
    return { note: `${label} is growing to ${s.next} observation slots (${s.cardinality} in use): its history reaches the oracle's 30 minutes once it has grown and traded through them` };
  }
  return {
    problem: `${label} has ${s.cardinality} observation slots (cardinalityNext ${s.next}): the oracle's 30-minute window needs ${need}, or a delivery can revert; grow it with the transactions from pnpm ops cardinality`,
  };
}

export async function readPool(ctx: Pick<Ctx, "rpc">, pool: Address): Promise<PoolSlots> {
  const s = (await read(ctx.rpc, "base", { address: pool, abi: POOL_ABI, functionName: "slot0" })) as readonly unknown[];
  return { cardinality: Number(s[3]), next: Number(s[4]) };
}

/** Preflight's check of both pools: [label, problem or null]. */
export async function poolProblems(ctx: Pick<Ctx, "rpc">): Promise<[string, string | null][]> {
  const out: [string, string | null][] = [];
  const need = await cardinalityNeededNow(ctx);
  for (const p of ORACLE_POOLS) {
    const f = cardinalityFinding(`the ${p.name}`, await readPool(ctx, p.address), need);
    out.push([`the ${p.name} (${p.address}) holds 30 minutes of history`, f.problem ?? null]);
  }
  return out;
}

/** verify's check of both pools: a short pool fails a launch and is a warning for a test deployment (which
 * ran with 600 slots); a growing one is a warning either way. */
export async function cardinalityChecks(ctx: Pick<Ctx, "rpc">, plan: PlanV3): Promise<Findings> {
  const out: Findings = { failures: [], warnings: [] };
  const launch = cadenceOf(plan) === "launch";
  const need = await cardinalityNeededNow(ctx);
  for (const p of ORACLE_POOLS) {
    const f = cardinalityFinding(`Base ${p.name} ${p.address}`, await readPool(ctx, p.address), need);
    if (f.problem) (launch ? out.failures : out.warnings).push(f.problem);
    if (f.note) out.warnings.push(f.note);
  }
  return out;
}

/** The cardinalityNext values to grow through from `next` to `target`, at most `maxStep` new slots each. */
export function cardinalitySteps(next: number, target: number, maxStep = MAX_NEW_SLOTS_PER_TX): number[] {
  const out: number[] = [];
  for (let n = next; n < target; ) {
    n = Math.min(n + maxStep, target);
    out.push(n);
  }
  return out;
}

export const cardinalityTxs = (pool: Address, steps: number[]): { to: Address; data: Hex; next: number }[] =>
  steps.map((next) => ({ to: pool, next, data: encodeFunctionData({ abi: POOL_ABI, functionName: "increaseObservationCardinalityNext", args: [next] }) }));

/** ETH from wei, to six places. */
const eth = (wei: bigint) => (Number(wei / 10n ** 12n) / 1e6).toFixed(6);

/** `pnpm ops cardinality`: each pool's slots, and for one below the target (cardinalityTarget: the v3.2 oracle's minimum,
 * from `contractsDir`'s build) the exact transactions that grow it, in order, each under Base's block gas limit and
 * TX_GAS_CAP, and what they cost in all at Base's gas price now. Anyone may send them (the pool's function is
 * permissionless), from any wallet. With `wallet` (--for-wallet --from), they also go in a call file in its `dir`, in
 * order and each with its gas limit, for pnpm ops sign to send from that account in MetaMask. Reads only; sends nothing. */
export async function cardinalityReport(ctx: Pick<Ctx, "rpc">, contractsDir: string, wallet?: { from: Address; dir: string; now: number }): Promise<string[]> {
  const lines: string[] = [];
  const calls: NewWalletCall[] = [];
  const blockS = await blockTimeOf(ctx.rpc, "base");
  const need = cardinalityNeeded(blockS);
  const target = cardinalityTarget(contractsDir, need);
  const latest = (await ctx.rpc.request("base", "eth_getBlockByNumber", ["latest", false])) as { gasLimit?: Hex } | null;
  if (!latest?.gasLimit) throw new Error("Base's latest block gave no gas limit: the steps can't be sized; nothing written");
  const blockGas = Number(hexToBigInt(latest.gasLimit));
  const maxStep = maxSlotsPerTx(blockGas);
  const gasPrice = hexToBigInt((await ctx.rpc.request("base", "eth_gasPrice", [])) as Hex);
  let total = { txs: 0, gas: 0, limit: 0 };
  lines.push(
    `Base makes a block every ${blockS.toFixed(2)} s (measured) and a pool keeps at most one observation a second, so the oracle's 30-minute window needs ${need} slots; the target is ${target}, the v3.2 oracle's minimum.`,
  );
  for (const p of ORACLE_POOLS) {
    const s = await readPool(ctx, p.address);
    const steps = cardinalitySteps(s.next, target, maxStep);
    if (!steps.length) {
      lines.push(`The ${p.name} ${p.address}: ${s.cardinality} observation slots (cardinalityNext ${s.next}): enough (the target is ${target}).`);
      continue;
    }
    lines.push(
      `The ${p.name} ${p.address}: ${s.cardinality} observation slots in use, cardinalityNext ${s.next}; the target is ${target}.`,
      `Base refuses a transaction above ${TX_GAS_CAP.toLocaleString("en-US")} gas, a block holds ${blockGas.toLocaleString("en-US")}, and each new slot costs about ${GAS_PER_SLOT.toLocaleString("en-US")}, so send ${steps.length === 1 ? "this transaction" : `these ${steps.length} transactions, in this order,`} from any wallet (no value; anyone may call it):`,
    );
    let from = s.next;
    cardinalityTxs(p.address, steps).forEach((t, i) => {
      const slots = t.next - from;
      total = { txs: total.txs + 1, gas: total.gas + slots * GAS_PER_SLOT, limit: total.limit + gasLimitFor(slots) };
      lines.push(
        `  ${i + 1}. to ${t.to} data ${t.data}  (increaseObservationCardinalityNext(${t.next}), about ${((slots * GAS_PER_SLOT) / 1e6).toFixed(1)}M gas; gas limit ${gasLimitFor(slots).toLocaleString("en-US")})`,
      );
      if (wallet) {
        calls.push({
          chainId: 8453,
          to: t.to,
          data: t.data,
          gas: gasLimitFor(slots),
          label: `increaseObservationCardinalityNext(${t.next}) on the ${p.name}, step ${i + 1} of ${steps.length}`,
          from: getAddress(wallet.from),
        });
      }
      from = t.next;
    });
    lines.push(
      `  With Foundry: cast send ${p.address} "increaseObservationCardinalityNext(uint16)" ${steps[0]} --gas-limit ${gasLimitFor(steps[0] - s.next)} --rpc-url <Base RPC> --keystore <your keystore>, then the next value with its own gas limit. Set the gas limit as given: a wallet that pads it could go over Base's cap.`,
      `Then the pool's history grows as it trades; run this again (or pnpm ops preflight) until it reads at least ${target} slots in use.`,
    );
  }
  if (total.txs) {
    const gwei = Number(gasPrice) / 1e9;
    lines.push(
      `In all: ${total.txs} transaction${total.txs === 1 ? "" : "s"}, about ${(total.gas / 1e6).toFixed(1)}M gas. At Base's gas price now (${gwei} gwei) that is about ${eth(BigInt(total.gas) * gasPrice)} ETH, and at most ${eth(BigInt(total.limit) * gasPrice)} ETH at the gas limits, plus Base's small L1 data fee on each.`,
    );
  }
  if (wallet) {
    if (calls.length) {
      const file = walletFile({ title: "Cascade: grow the oracle pools' observation slots", ordered: true, now: wallet.now, calls });
      const path = writeWalletFile(wallet.dir, "cardinality", file);
      lines.push(wroteLine(path, calls.length));
    } else {
      lines.push("Both pools have enough slots: there is nothing for the wallet page to send.");
    }
  }
  return lines;
}
