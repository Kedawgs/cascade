import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { numberToHex } from "viem";
import { loadArtifact } from "./artifacts.ts";
import { type ChainName, type Env, PRECOMPILE, paths, targets, WALLET } from "./config.ts";
import { deploy } from "./deploy.ts";
import { type DeploymentRecord, saveRecord } from "./record.ts";
import { chainIdOf, createRpc, type Rpc } from "./rpc.ts";
import { type Ctx, execFileRunner } from "./send.ts";
import { verify } from "./verify.ts";

const BITTENSOR_ARCHIVE = "https://archive.chain.opentensor.ai";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUp(rpc: Rpc, chain: ChainName, ms = 180_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await chainIdOf(rpc, chain);
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`the local ${chain} fork did not start: ${(e as Error).message}`);
      await sleep(1_000);
    }
  }
}

export interface Rehearsal {
  ctx: Ctx;
  recordPath: string;
  stop(): void;
}

/** Two local anvil forks at the live state with their own chain ids (31337, 31338), so nothing signed
 * here can be replayed on Base or Bittensor; stand-ins at Bittensor's precompile addresses. */
export async function startForks(env: Env, log: (l: string) => void): Promise<Rehearsal> {
  const p = paths(env);
  const t = targets(env);
  mkdirSync(p.deploymentsDir, { recursive: true });
  const anvil = join(p.foundryBin, process.platform === "win32" ? "anvil.exe" : "anvil");
  const procs: ChildProcess[] = [];
  const start = (args: string[], name: string) => {
    const out = openSync(join(p.deploymentsDir, name), "w");
    procs.push(spawn(anvil, args, { stdio: ["ignore", out, out], windowsHide: true }));
  };
  const stop = () => {
    for (const c of procs) c.kill();
  };
  try {
    start(["--fork-url", t.live.base.rpcUrl, "--port", "8545", "--chain-id", "31337"], "rehearsal-anvil-base.log");
    start(
      ["--fork-url", BITTENSOR_ARCHIVE, "--port", "8547", "--chain-id", "31338", "--retries", "12", "--fork-retry-backoff", "20000", "--timeout", "60000"],
      "rehearsal-anvil-bittensor.log",
    );
    const rpc = createRpc(t.rehearsal, { minIntervalMs: { bittensor: 0 } });
    await waitUp(rpc, "base");
    await waitUp(rpc, "bittensor");
    const standIns: [string, string][] = [
      ["RehearsalAddressMapping", PRECOMPILE.addressMapping],
      ["RehearsalStaking", PRECOMPILE.staking],
      ["RehearsalBalanceTransfer", PRECOMPILE.balanceTransfer],
    ];
    for (const [name, addr] of standIns) {
      await rpc.request("bittensor", "anvil_setCode", [addr, loadArtifact(p.contractsDir, name).deployedBytecode]);
    }
    for (const chain of ["base", "bittensor"] as const) {
      await rpc.request(chain, "anvil_setBalance", [WALLET, numberToHex(10n ** 18n)]);
      // the forked Bittensor block has no prevrandao, which anvil's EVM requires; a local block has one
      await rpc.request(chain, "evm_mine", []);
    }
    log("Started local forks of Base and Bittensor (chain ids 31337 and 31338)");
    const ctx: Ctx = { live: false, targets: t.rehearsal, rpc, runner: execFileRunner, paths: p, log, receiptTimeoutMs: 120_000, pollMs: 500 };
    return { ctx, recordPath: join(p.deploymentsDir, "rehearsal.json"), stop };
  } catch (e) {
    stop();
    throw e;
  }
}

/** The full deployment and read-back on the local forks. Each run starts from fresh forks, so it
 * always plans anew. */
export async function rehearse(env: Env, log: (l: string) => void, extra?: (r: Rehearsal, rec: DeploymentRecord) => Promise<void>) {
  const r = await startForks(env, log);
  try {
    const rec = await deploy(r.ctx, r.recordPath, { newPlan: true });
    rec.verify = await verify(r.ctx, rec);
    saveRecord(r.recordPath, rec);
    log(
      rec.verify.ok
        ? "Read-back check: everything matches the plan"
        : `Read-back check failed:\n  ${rec.verify.failures.join("\n  ")}`,
    );
    if (rec.verify.ok && extra) await extra(r, rec);
    return rec;
  } finally {
    r.stop();
  }
}
