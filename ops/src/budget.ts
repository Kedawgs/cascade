import { encodeDeployData, formatEther, getContractAddress, type Hex, hexToBigInt } from "viem";
import { loadArtifact } from "./artifacts.ts";
import { CLAIM_POLICY, type ClaimPolicy, SETTINGS, WALLET, WALLET_SS58 } from "./config.ts";
import { readColdkey } from "./deploy.ts";
import { claimGasLimit, VAULT_CLAIM_GAS_REQUIRED } from "./keeper/rewards.ts";
import { buildPlan, buildPlanV3, isPlanV3 } from "./plan.ts";
import type { DeploymentRecord } from "./record.ts";
import type { ROUND_TRIP } from "./roundtrip.ts";
import { balanceOf, gasPriceOf, nonceOf } from "./rpc.ts";
import type { Ctx } from "./send.ts";
import type { StepId } from "./types.ts";

export interface BudgetInputs {
  bitCreateGas: { bitAdapter: bigint; vault: bigint };
  bitConfigGas: bigint;
  /** Every Base step of the deployment, creates and configuration calls */
  baseDeployGas: bigint;
  /** How many Base transactions the deployment sends */
  baseDeploySteps: number;
  closeGas: bigint;
  /** v3: one USDC delivery's gas, from the rehearsal's round trip */
  deliverGas?: bigint;
  bitGasPrice: bigint;
  baseGasPrice: bigint;
  baseFeeQuote: bigint;
  taoBalance: bigint;
  ethBalance: bigint;
  /** v3: the gas limit a reward claim is sent with, which Bittensor charges up front */
  claimGasLimit?: bigint;
  /** v3: what one claim costs (the claim policy's, so OPS_CLAIM_COST_TAO applies) */
  claimCostTao?: bigint;
}

export interface Budget {
  taoNeed: bigint;
  ethNeed: bigint;
  taoToSend: bigint;
  ethToSend: bigint;
  taoBalance: bigint;
  ethBalance: bigint;
  /** What the Base need covers */
  baseTxs: { deploy: number; closes: number; deliveries: number };
  /** v3: a reward claim, which the test run doesn't need and the totals above leave out */
  claim?: { gasLimit: bigint; upfront: bigint; cost: bigint; taoToSendWith: bigint };
}

/** What the keeper spends on Bittensor during the test: two stakes, one payout batch, the sweep. */
const KEEPER_BIT_GAS = 2n * 500_000n + 3_000_000n + 30_000n;
const CLOSES = 3n;
/** v3: the keeper delivers USDC for each redeem; one, and one spare. */
const DELIVERIES = 2n;
/** Base's L1 data fee, which the forks don't charge: an allowance per Base transaction. */
const L1_PER_TX = 4n * 10n ** 13n;
/** v3: a delivery's gas when the rehearsal record has none. */
const DEFAULT_DELIVER_GAS = 500_000n;

const ceil13 = (x: bigint) => (x * 13n + 9n) / 10n;
const roundUp = (x: bigint, step: bigint) => ((x + step - 1n) / step) * step;
const toSend = (need: bigint, have: bigint, step: bigint) => (need > have ? roundUp(need - have, step) : 0n);

export function computeBudget(i: BudgetInputs): Budget {
  const bitGas = i.bitCreateGas.bitAdapter + i.bitCreateGas.vault + i.bitConfigGas + KEEPER_BIT_GAS;
  const taoNeed = ceil13(bitGas * i.bitGasPrice + SETTINGS.adapterReserve + SETTINGS.vaultReserve);
  const deliveries = i.deliverGas === undefined ? 0n : DELIVERIES;
  const baseGas = i.baseDeployGas + CLOSES * i.closeGas + deliveries * (i.deliverGas ?? 0n);
  const baseTxs = BigInt(i.baseDeploySteps) + CLOSES + deliveries;
  const ethNeed = ceil13(baseGas * i.baseGasPrice + (CLOSES * i.baseFeeQuote * 125n) / 100n) + baseTxs * L1_PER_TX;
  const taoToSend = toSend(taoNeed, i.taoBalance, 10n ** 15n);
  // the same 30% margin as the rest of the TAO need, for a gas price that rises before the claim
  const upfront = i.claimGasLimit === undefined ? undefined : ceil13(i.claimGasLimit * i.bitGasPrice);
  return {
    taoNeed,
    ethNeed,
    taoToSend,
    ethToSend: toSend(ethNeed, i.ethBalance, 10n ** 14n),
    taoBalance: i.taoBalance,
    ethBalance: i.ethBalance,
    baseTxs: { deploy: i.baseDeploySteps, closes: Number(CLOSES), deliveries: Number(deliveries) },
    ...(upfront === undefined || i.claimGasLimit === undefined
      ? {}
      : {
          claim: {
            gasLimit: i.claimGasLimit,
            upfront,
            cost: i.claimCostTao ?? CLAIM_POLICY.claimCostTao,
            // the claim comes after the deployment's and the keeper's spending, so it needs its up-front sum on top
            taoToSendWith: toSend(taoNeed + upfront, i.taoBalance, 10n ** 15n),
          },
        }),
  };
}

export function formatBudget(b: Budget): string[] {
  const t = b.baseTxs;
  const covers = `the deployment's ${t.deploy} transactions, ${t.closes} batch closes with their bridge fees${t.deliveries ? `, ${t.deliveries} USDC deliveries` : ""}`;
  const lines = [
    `Bittensor: about ${formatEther(b.taoNeed)} TAO needed in total; the test wallet holds ${formatEther(b.taoBalance)} TAO`,
    b.taoToSend > 0n
      ? `Send ${formatEther(b.taoToSend)} TAO to the test wallet's Bittensor address ${WALLET_SS58}`
      : "No TAO needed: the test wallet already holds enough on Bittensor",
    `Base: about ${formatEther(b.ethNeed)} ETH needed in total (${covers}); the test wallet holds ${formatEther(b.ethBalance)} ETH`,
    b.ethToSend > 0n
      ? `Send ${formatEther(b.ethToSend)} ETH on Base to ${WALLET}`
      : "No ETH needed: the test wallet already holds enough on Base",
  ];
  const c = b.claim;
  if (c) {
    lines.push(
      `Optional, not counted above: a reward claim is sent with a ${c.gasLimit.toLocaleString("en-US")} gas limit, so the wallet must hold about ${formatEther(c.upfront)} TAO up front when it claims (that limit at today's gas price, plus 30%); Bittensor refunds the unused gas, and a claim costs about ${formatEther(c.cost)} TAO`,
      c.taoToSendWith > b.taoToSend
        ? `To be able to claim during the test, send ${formatEther(c.taoToSendWith)} TAO in all instead`
        : "The wallet already holds enough TAO to claim as well",
    );
  }
  return lines;
}

const sumGas = (rec: DeploymentRecord, ids: StepId[]) =>
  ids.reduce((s, id) => {
    const d = rec.done[id];
    return s + (d && "gasUsed" in d ? d.gasUsed : 0n);
  }, 0n);

const estimateCreate = async (ctx: Ctx, name: string, args: unknown[]) => {
  const a = loadArtifact(ctx.paths.contractsDir, name);
  const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args } as never);
  return hexToBigInt((await ctx.rpc.request("bittensor", "eth_estimateGas", [{ from: WALLET, data }])) as Hex);
};

/** Live reads and estimates (no sends) plus the rehearsal's measured gas: every Base step of its plan,
 * every Bittensor configuration call and, for v3, its round trip's USDC delivery and the claim policy's
 * cost of a claim. `ctx` points at the live chains. */
export async function gatherBudgetInputs(ctx: Ctx, rehearsal: DeploymentRecord, policy: ClaimPolicy = CLAIM_POLICY): Promise<BudgetInputs> {
  // an estimate creates at the wallet's current nonce, so the vault's coldkey is that address's
  const nonce = await nonceOf(ctx.rpc, "bittensor", WALLET);
  const here = getContractAddress({ from: WALLET, nonce: BigInt(nonce) });
  const v3 = isPlanV3(rehearsal.plan);
  const coldkey = await readColdkey(ctx, here);
  const live = v3 ? buildPlanV3(0, nonce, coldkey) : buildPlan(0, nonce, coldkey);
  const args = (id: StepId) => live.steps.find((s) => s.id === id)!.args;
  const steps = rehearsal.plan.steps;
  const baseSteps = steps.filter((s) => s.chain === "base").map((s) => s.id);
  const bitCalls = steps.filter((s) => s.chain === "bittensor" && s.kind === "call").map((s) => s.id);
  const deliverStep: (typeof ROUND_TRIP)[number] = "deliver USDC";
  const delivery = rehearsal.roundTrip?.find((s) => s.step === deliverStep);
  return {
    bitCreateGas: {
      bitAdapter: await estimateCreate(ctx, "CcipBittensorAdapter", args("bitAdapter")),
      vault: await estimateCreate(ctx, "CascadeVault", args("vault")),
    },
    bitConfigGas: sumGas(rehearsal, bitCalls),
    baseDeployGas: sumGas(rehearsal, baseSteps),
    baseDeploySteps: baseSteps.length,
    closeGas: rehearsal.rehearsalClose?.gasUsed ?? 400_000n,
    baseFeeQuote: rehearsal.rehearsalClose?.fee ?? 10n ** 15n,
    bitGasPrice: await gasPriceOf(ctx.rpc, "bittensor"),
    baseGasPrice: await gasPriceOf(ctx.rpc, "base"),
    taoBalance: await balanceOf(ctx.rpc, "bittensor", WALLET),
    ethBalance: await balanceOf(ctx.rpc, "base", WALLET),
    ...(v3
      ? { deliverGas: delivery?.gasUsed ?? DEFAULT_DELIVER_GAS, claimGasLimit: claimGasLimit(VAULT_CLAIM_GAS_REQUIRED), claimCostTao: policy.claimCostTao }
      : {}),
  };
}
