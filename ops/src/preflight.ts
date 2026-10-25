import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { type Address, getContractAddress, parseAbi } from "viem";
import type { Budget } from "./budget.ts";
import { type ChainName, LIVE, SETTINGS, WALLET } from "./config.ts";
import type { DeploymentRecord } from "./record.ts";
import { balanceOf, nonceOf, read } from "./rpc.ts";
import { type Ctx, chainLabel } from "./send.ts";

const ROUTER = parseAbi([
  "struct OffRamp { uint64 sourceChainSelector; address offRamp; }",
  "function getOffRamps() view returns (OffRamp[])",
  "function typeAndVersion() view returns (string)",
]);
const ALPHA = parseAbi([
  "function isPaused() view returns (bool)",
  "function migrationReadyAt() view returns (uint256)",
  "function migrationFinished() view returns (bool)",
]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** As the fork harness's offRamp20: exactly one OffRamp 2.0.0 for the source (other versions may
 * sit beside it), at the expected address. */
export function checkOffRamps(
  list: readonly { sourceChainSelector: bigint; offRamp: Address; version: string }[],
  source: bigint,
  expected: Address,
): string | null {
  const v2 = list.filter((r) => r.sourceChainSelector === source && r.version === "OffRamp 2.0.0");
  if (v2.length !== 1) return `the Router lists ${v2.length} OffRamps 2.0.0 for this lane, expected exactly 1`;
  if (!same(v2[0].offRamp, expected)) return `the lane's OffRamp 2.0.0 is ${v2[0].offRamp}, expected ${expected}`;
  return null;
}

export function checkAlphaVault(s: { isPaused: boolean; migrationReadyAt: bigint; migrationFinished: boolean }): string | null {
  if (s.isPaused) return "ForeverMoney's AlphaVault is paused";
  if (s.migrationReadyAt !== 0n) return "ForeverMoney's AlphaVault has a migration announced: do not deploy or close batches";
  if (s.migrationFinished) return "ForeverMoney's AlphaVault has migrated: inbound batches would be stranded";
  return null;
}

export const simulationPassed = (out: string) => /^SIMULATION OK/m.test(out);

export const bashPath = (env: Record<string, string | undefined>) =>
  env.OPS_BASH ??
  (process.platform === "win32" && existsSync("C:\\Program Files\\Git\\bin\\bash.exe") ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");

/** Read-only checks against the live chains before deploying (and before any batch). */
export async function preflight(ctx: Ctx, rec: DeploymentRecord | null, budget?: Budget): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const check = (label: string, problem: string | null) => {
    if (problem) ok = false;
    lines.push(problem ? `PROBLEM — ${label}: ${problem}` : `OK — ${label}`);
  };

  const lanes: [ChainName, bigint, Address, string][] = [
    ["base", LIVE.bittensor.SELECTOR, LIVE.base.OFFRAMP, "Bittensor → Base lane"],
    ["bittensor", LIVE.base.SELECTOR, LIVE.bittensor.OFFRAMP, "Base → Bittensor lane"],
  ];
  for (const [chain, source, expected, label] of lanes) {
    const all = (await read(ctx.rpc, chain, { address: LIVE[chain].ROUTER, abi: ROUTER, functionName: "getOffRamps" })) as {
      sourceChainSelector: bigint;
      offRamp: Address;
    }[];
    const list = [];
    for (const r of all.filter((r) => r.sourceChainSelector === source)) {
      const version = (await read(ctx.rpc, chain, { address: r.offRamp, abi: ROUTER, functionName: "typeAndVersion" })) as string;
      list.push({ ...r, version });
    }
    check(`${label} executes on OffRamp 2.0.0 at ${expected}`, checkOffRamps(list, source, expected));
  }

  const alpha = (fn: string) => read(ctx.rpc, "bittensor", { address: LIVE.ALPHA_VAULT, abi: ALPHA, functionName: fn });
  check(
    "ForeverMoney's AlphaVault is open (not paused, no migration)",
    checkAlphaVault({
      isPaused: (await alpha("isPaused")) as boolean,
      migrationReadyAt: (await alpha("migrationReadyAt")) as bigint,
      migrationFinished: (await alpha("migrationFinished")) as boolean,
    }),
  );

  const nonces = { base: await nonceOf(ctx.rpc, "base", WALLET), bittensor: await nonceOf(ctx.rpc, "bittensor", WALLET) };
  for (const chain of ["base", "bittensor"] as const) {
    const next = rec?.plan.steps.find((s) => s.chain === chain && !rec.done[s.id]);
    check(
      `${chainLabel(chain)} nonce is ${nonces[chain]}`,
      next && next.nonce !== nonces[chain] ? `the deployment record expects ${next.nonce}: run deploy --new-plan` : null,
    );
  }

  if (budget) {
    const tao = await balanceOf(ctx.rpc, "bittensor", WALLET);
    const eth = await balanceOf(ctx.rpc, "base", WALLET);
    check("the test wallet holds enough TAO", tao < budget.taoNeed ? `it holds ${tao} wei, the budget needs ${budget.taoNeed}` : null);
    check("the test wallet holds enough ETH on Base", eth < budget.ethNeed ? `it holds ${eth} wei, the budget needs ${budget.ethNeed}` : null);
  }

  const remote = rec?.plan.addresses.baseAdapter ?? getContractAddress({ from: WALLET, nonce: BigInt(nonces.base) });
  const out = await ctx.runner.run(bashPath(process.env), ["script/simulate_inbound.sh"], {
    cwd: ctx.paths.contractsDir,
    env: {
      ...process.env,
      PATH: `${ctx.paths.foundryBin}${delimiter}${process.env.PATH ?? ""}`,
      BITTENSOR_RPC: ctx.targets.bittensor.rpcUrl,
      REMOTE_ADAPTER: remote,
      GAS_BASE: SETTINGS.bitGas.base.toString(),
      GAS_PER_ENTRY: SETTINGS.bitGas.perEntry.toString(),
    },
  });
  const verdict = `${out.stdout}\n${out.stderr}`.split("\n").find((l) => l.startsWith("SIMULATION")) ?? out.stderr.trim();
  check(`a delivery from ${remote} simulated on the live node`, simulationPassed(out.stdout) ? null : verdict);
  return { ok, lines };
}
