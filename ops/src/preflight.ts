import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { type Address, parseAbi } from "viem";
import { type Budget, budgetChecks } from "./budget.ts";
import { poolProblems } from "./cardinality.ts";
import { type ChainName, LIVE, WALLET } from "./config.ts";
import type { DeploymentRecord } from "./record.ts";
import { windowOf } from "./keeper/state.ts";
import { nonceOf, read } from "./rpc.ts";
import { type Ctx, chainLabel, logsOf } from "./send.ts";
import type { DeploymentRecordV32 } from "./v32/deploy.ts";
import { isPlanV32 } from "./v32/plan.ts";
import { FUNDING_V32, SETTINGS_V32_LAUNCH } from "./v32/settings.ts";

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

/** One eth_getLogs over the keeper's window on `chain`, through the logs server the scans use (Base:
 * OPS_BASE_LOGS_RPC), its head from there too: null if it accepts it. */
export async function logProbe(ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">, chain: ChainName): Promise<string | null> {
  try {
    const rpc = logsOf(ctx);
    const latest = BigInt((await rpc.request(chain, "eth_blockNumber", [])) as string);
    await rpc.request(chain, "eth_getLogs", [
      { address: LIVE[chain].ROUTER, fromBlock: `0x${(latest - windowOf(ctx, chain) + 1n).toString(16)}`, toBlock: `0x${latest.toString(16)}` },
    ]);
    return null;
  } catch (e) {
    return `the RPC refused a ${windowOf(ctx, chain)}-block log query (${(e as Error).message})`;
  }
}

export const simulationPassed = (out: string) => /^SIMULATION OK/m.test(out);

export const bashPath = (env: Record<string, string | undefined>) =>
  env.OPS_BASH ??
  (process.platform === "win32" && existsSync("C:\\Program Files\\Git\\bin\\bash.exe") ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");

/** What contracts/script/simulate_inbound.sh simulates, by the deployment's plan: this checkout's Bittensor adapter is
 * v3.2's, so a v3.2 deployment (its record's plan, or, before its record exists, its name) simulates it with v3.2's
 * launch values (its gas model toward Base, its cap, its treasury, the reserve the deploy funds (RESERVE_TARGET and 500 rao), and the
 * record's Base adapter as the sender once planned); any other deployment would simulate v3.2's adapter in place of the
 * one it deployed, so the check is refused for it, with the reason (`skip`), and fails. The script's own defaults stand
 * for what is not given. */
export function simulationInputs(rec: DeploymentRecord | DeploymentRecordV32 | null, v32Deployment: boolean): { env: Record<string, string> } | { skip: string } {
  if (rec && isPlanV32(rec.plan)) {
    const p = rec.plan;
    return { env: v32SimulationEnv(p.addresses.baseAdapter, p.roles.treasury) };
  }
  if (!rec && v32Deployment) return { env: v32SimulationEnv(undefined, SETTINGS_V32_LAUNCH.treasury) };
  return {
    skip: "this checkout's adapter is v3.2's, not the one v3-launch deployed, so the simulation would test other code: run preflight for v3-launch from a checkout of its build (main)",
  };
}

const v32SimulationEnv = (remote: Address | undefined, treasury: Address): Record<string, string> => ({
  ...(remote ? { REMOTE_ADAPTER: remote } : {}),
  GAS_BASE: SETTINGS_V32_LAUNCH.gas.towardBase.base.toString(),
  GAS_PER_ENTRY: SETTINGS_V32_LAUNCH.gas.towardBase.perEntry.toString(),
  INBOUND_GAS_BASE: SETTINGS_V32_LAUNCH.gas.towardBittensor.base.toString(),
  INBOUND_GAS_PER_ENTRY: SETTINGS_V32_LAUNCH.gas.towardBittensor.perEntry.toString(),
  MAX_MESSAGE: SETTINGS_V32_LAUNCH.adapters.maxMessageValue.bittensor.toString(),
  TREASURY: treasury,
  RESERVE: FUNDING_V32.adapterReserve.toString(),
});

/** Read-only checks against the live chains before deploying (and before any batch). `o.v32`: the deployment is a
 * v3.2 one (OPS_DEPLOYMENT v3.2-…), which matters before its record exists. */
export async function preflight(
  ctx: Ctx,
  rec: DeploymentRecord | DeploymentRecordV32 | null,
  budget?: Budget,
  o: { v32?: boolean } = {},
): Promise<{ ok: boolean; lines: string[] }> {
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

  for (const chain of ["base", "bittensor"] as const) {
    const which = chain === "base" ? "Base's logs RPC (OPS_BASE_LOGS_RPC)" : "Bittensor's RPC";
    check(`${which} answers the keeper's log queries`, await logProbe(ctx, chain));
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

  // the oracle's 30-minute TWAP needs that much history in both pools, or deliveries can revert
  for (const [label, problem] of await poolProblems(ctx)) check(label, problem);

  // whose nonces: v3.2's deployers (deploy --v32 checks them again, both nonces, before it sends), else the test wallet
  const v32Plan = rec && isPlanV32(rec.plan) ? rec.plan : undefined;
  const sender = (chain: ChainName): Address => v32Plan?.deployers[chain] ?? WALLET;
  const nonces = { base: await nonceOf(ctx.rpc, "base", sender("base")), bittensor: await nonceOf(ctx.rpc, "bittensor", sender("bittensor")) };
  // a v3.2 deployment not yet planned has no deployer to name here: the test wallet's nonces say nothing of it
  for (const chain of o.v32 && !rec ? [] : (["base", "bittensor"] as const)) {
    const steps = rec?.plan.steps as { id: string; chain: ChainName; nonce: number }[] | undefined;
    const done = (rec?.done ?? {}) as Record<string, unknown>;
    const next = steps?.find((s) => s.chain === chain && !done[s.id]);
    check(
      `${chainLabel(chain)} nonce${v32Plan ? ` of the deployer ${sender(chain)}` : ""} is ${nonces[chain]}`,
      next && next.nonce !== nonces[chain] ? `the deployment record expects ${next.nonce}: run deploy${v32Plan ? " --v32" : ""} --new-plan${v32Plan ? " with fresh keys" : ""}` : null,
    );
  }

  if (budget) {
    // the balances the budget just read: the test wallet's, and a separate keeper key's against its share
    for (const [label, problem] of budgetChecks(budget)) check(label, problem);
  }

  // the simulation runs this checkout's Bittensor adapter, v3.2's: routed by the deployment's plan
  const sim = simulationInputs(rec, o.v32 ?? false);
  if ("skip" in sim) {
    check("a delivery simulated on the live node", sim.skip);
    return { ok, lines };
  }
  const remote = sim.env.REMOTE_ADAPTER ?? "0x1111111111111111111111111111111111111111";
  const out = await ctx.runner.run(bashPath(process.env), ["script/simulate_inbound.sh"], {
    cwd: ctx.paths.contractsDir,
    env: {
      ...process.env,
      PATH: `${ctx.paths.foundryBin}${delimiter}${process.env.PATH ?? ""}`,
      BITTENSOR_RPC: ctx.targets.bittensor.rpcUrl,
      ...sim.env,
    },
  });
  const verdict = `${out.stdout}\n${out.stderr}`.split("\n").find((l) => l.startsWith("SIMULATION")) ?? out.stderr.trim();
  check(`a delivery from ${remote} simulated on the live node`, simulationPassed(out.stdout) ? null : verdict);
  return { ok, lines };
}
