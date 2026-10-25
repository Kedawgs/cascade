import { encodeDeployData, formatEther, getContractAddress, type Hex, hexToBigInt } from "viem";
import { loadArtifact } from "./artifacts.ts";
import { SETTINGS, WALLET, WALLET_SS58 } from "./config.ts";
import { readColdkey } from "./deploy.ts";
import { buildPlan } from "./plan.ts";
import type { DeploymentRecord } from "./record.ts";
import { balanceOf, gasPriceOf, nonceOf } from "./rpc.ts";
import type { Ctx } from "./send.ts";
import type { StepId } from "./types.ts";

export interface BudgetInputs {
  bitCreateGas: { bitAdapter: bigint; vault: bigint };
  bitConfigGas: bigint;
  baseDeployGas: bigint;
  closeGas: bigint;
  bitGasPrice: bigint;
  baseGasPrice: bigint;
  baseFeeQuote: bigint;
  taoBalance: bigint;
  ethBalance: bigint;
}

export interface Budget {
  taoNeed: bigint;
  ethNeed: bigint;
  taoToSend: bigint;
  ethToSend: bigint;
  taoBalance: bigint;
  ethBalance: bigint;
}

/** What the keeper spends on Bittensor during the test: two stakes, one payout batch, the sweep. */
const KEEPER_BIT_GAS = 2n * 500_000n + 3_000_000n + 30_000n;
const CLOSES = 3n;
const L1_ALLOWANCE = 2n * 10n ** 14n;

const ceil13 = (x: bigint) => (x * 13n + 9n) / 10n;
const roundUp = (x: bigint, step: bigint) => ((x + step - 1n) / step) * step;
const toSend = (need: bigint, have: bigint, step: bigint) => (need > have ? roundUp(need - have, step) : 0n);

export function computeBudget(i: BudgetInputs): Budget {
  const bitGas = i.bitCreateGas.bitAdapter + i.bitCreateGas.vault + i.bitConfigGas + KEEPER_BIT_GAS;
  const taoNeed = ceil13(bitGas * i.bitGasPrice + SETTINGS.adapterReserve + SETTINGS.vaultReserve);
  const baseGas = i.baseDeployGas + CLOSES * i.closeGas;
  const ethNeed = ceil13(baseGas * i.baseGasPrice + (CLOSES * i.baseFeeQuote * 125n) / 100n) + L1_ALLOWANCE;
  return {
    taoNeed,
    ethNeed,
    taoToSend: toSend(taoNeed, i.taoBalance, 10n ** 15n),
    ethToSend: toSend(ethNeed, i.ethBalance, 10n ** 14n),
    taoBalance: i.taoBalance,
    ethBalance: i.ethBalance,
  };
}

export function formatBudget(b: Budget): string[] {
  return [
    `Bittensor: about ${formatEther(b.taoNeed)} TAO needed in total; the test wallet holds ${formatEther(b.taoBalance)} TAO`,
    b.taoToSend > 0n
      ? `Send ${formatEther(b.taoToSend)} TAO to the test wallet's Bittensor address ${WALLET_SS58}`
      : "No TAO needed: the test wallet already holds enough on Bittensor",
    `Base: about ${formatEther(b.ethNeed)} ETH needed in total; the test wallet holds ${formatEther(b.ethBalance)} ETH`,
    b.ethToSend > 0n
      ? `Send ${formatEther(b.ethToSend)} ETH on Base to ${WALLET}`
      : "No ETH needed: the test wallet already holds enough on Base",
  ];
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

/** Live reads and estimates (no sends) plus the rehearsal's measured gas. `ctx` points at the live chains. */
export async function gatherBudgetInputs(ctx: Ctx, rehearsal: DeploymentRecord): Promise<BudgetInputs> {
  // an estimate creates at the wallet's current nonce, so the vault's coldkey is that address's
  const nonce = await nonceOf(ctx.rpc, "bittensor", WALLET);
  const here = getContractAddress({ from: WALLET, nonce: BigInt(nonce) });
  const live = buildPlan(0, nonce, await readColdkey(ctx, here));
  const args = (id: StepId) => live.steps.find((s) => s.id === id)!.args;
  return {
    bitCreateGas: {
      bitAdapter: await estimateCreate(ctx, "CcipBittensorAdapter", args("bitAdapter")),
      vault: await estimateCreate(ctx, "CascadeVault", args("vault")),
    },
    bitConfigGas: sumGas(rehearsal, ["adapterReserve", "vaultReserve", "setKeeper", "setPayoutDelay"]),
    baseDeployGas: sumGas(rehearsal, ["baseAdapter", "frontDoor"]),
    closeGas: rehearsal.rehearsalClose?.gasUsed ?? 400_000n,
    baseFeeQuote: rehearsal.rehearsalClose?.fee ?? 10n ** 15n,
    bitGasPrice: await gasPriceOf(ctx.rpc, "bittensor"),
    baseGasPrice: await gasPriceOf(ctx.rpc, "base"),
    taoBalance: await balanceOf(ctx.rpc, "bittensor", WALLET),
    ethBalance: await balanceOf(ctx.rpc, "base", WALLET),
  };
}
