import { basename, resolve } from "node:path";
import { formatEther, numberToHex } from "viem";
import { type Env, targets } from "../../ops/src/config.ts";
import { decodeDeployment, encodeDeployment } from "../../ops/src/keeper/core/deployment.ts";
import { chainIdOf, createRpc, type Rpc } from "../../ops/src/keeper/core/rpc.ts";
import { deploymentFromRecordV32, vaultCreatedAtOf } from "../../ops/src/keeper/deployment-v32.ts";
import type { BuildV32 } from "../../ops/src/v32/build.ts";
import { type DeploymentRecordV32, loadRecordV32For } from "../../ops/src/v32/deploy.ts";
import { joinDeploymentVars, splitDeploymentVars } from "../src/deployment-vars.ts";
import { argsOf, isMain } from "./io.ts";

// pnpm config:from-record -- <record.json> [--name <deployment>] [--rehearsal]
//   Prints the Worker's deployment vars for wrangler.jsonc (Task 62 for test, Task 67 for production): DEPLOYMENT and,
//   since a real record is above the 5 kB Cloudflare takes in one var, its for-life list in numbered parts
//   (DEPLOYMENT_FOR_LIFE_1, _2, ...: src/deployment-vars.ts; the Worker joins them and holds them to the digest
//   DEPLOYMENT names, so vars of two printouts never mix). They replace the environment's DEPLOYMENT line, every old
//   DEPLOYMENT_FOR_LIFE_ var with it. It is the v3.2
//   deployment built from its record, its frozen build and the web's deployments.json (Task 50's
//   deploymentFromRecordV32, never verify.ok), the chains' ids as their RPCs answer them, and the vault's creation time
//   read once from Bittensor (vaultCreatedAtOf). The Bittensor RPC must keep history (the keeper scans its logs from
//   the start blocks): one without the creation block, or without its logs, is refused. RPCs: OPS_BASE_RPC and
//   OPS_BITTENSOR_RPC from ops/.env (the archive node by default). Reads only.
//   The 24 h spend caps are OPS_KEEPER_SPEND_CAP_BASE and OPS_KEEPER_SPEND_CAP_BITTENSOR when set, else the defaults the
//   core's deployment carries (deployment-v32.ts SPEND_CAP_DEFAULT): 0.01 ETH, a day's closes (R12a), and on Bittensor
//   0.4 TAO, one claim's worst case with a day of payouts and stakes beside it (Task 51). Printed beside the var, so the
//   founder sees them.
//   Task 52's lane ends (each chain's CCIP OnRamp and selector) and the park refund's fee cap (OPS_PARK_REFUND_FEE_MAX,
//   else the core's 0.05 TAO) go in the var; the automatic re-execution of CCIP FAILUREs never does: the Worker's own
//   OPS_REEXEC_AUTO var decides it (off in wrangler.jsonc), which this prints too.

const LIVE_IDS = { base: 8453, bittensor: 964 };

export async function configFromRecord(o: { rec: DeploymentRecordV32; name: string; rpc: Rpc; env: Env; build?: BuildV32; web?: { batchMaxWaitS?: unknown; usdcDelivery?: unknown } | null }) {
  const chainIds = { base: await chainIdOf(o.rpc, "base"), bittensor: await chainIdOf(o.rpc, "bittensor") };
  if (o.rec.target === "live" && (chainIds.base !== LIVE_IDS.base || chainIds.bittensor !== LIVE_IDS.bittensor)) {
    throw new Error(`the record is live, but the RPCs answer chain ids ${chainIds.base} (Base) and ${chainIds.bittensor} (Bittensor), not ${LIVE_IDS.base} and ${LIVE_IDS.bittensor}; nothing built`);
  }
  const vaultCreatedAt = await vaultCreatedAtOf(o.rpc, o.rec);
  // the history probe: the vault's constructor logs at its creation block, which a pruned node no longer serves
  const block = o.rec.done.vault?.block as number;
  const logs = (await o.rpc.request("bittensor", "eth_getLogs", [{ address: o.rec.plan.addresses.vault, fromBlock: numberToHex(block), toBlock: numberToHex(block) }])) as unknown[];
  if (!Array.isArray(logs) || logs.length === 0) {
    throw new Error(`this Bittensor RPC has no logs at block ${block}, where the vault was created: it doesn't keep history (a pruned node); use an archive node (archive.chain.opentensor.ai); nothing built`);
  }
  // the spend caps: the env's, else SPEND_CAP_DEFAULT (deploymentFromRecordV32's spendCapOf), never a value of this file's
  const built = deploymentFromRecordV32(o.rec, { name: o.name, chainIds, vaultCreatedAt, env: o.env, ...(o.build ? { build: o.build } : {}), ...(o.web !== undefined ? { web: o.web } : {}) });
  // the automatic re-execution is the Worker's own var, never the shell's (Task 52w): left out of the var
  const { reexecAuto, ...deployment } = built;
  const caps = `24 h spend caps: ${formatEther(deployment.spendCap.base)} ETH on Base, ${formatEther(deployment.spendCap.bittensor)} TAO on Bittensor`;
  const worker = "the Worker's OPS_REEXEC_AUTO var decides (off in wrangler.jsonc; on only after the rehearsals)";
  const reexec = reexecAuto
    ? "Automatic re-execution of CCIP FAILUREs: OPS_REEXEC_AUTO is on in this shell, but the Worker reads its own OPS_REEXEC_AUTO var (off in wrangler.jsonc; on only after the rehearsals); nothing of it is in DEPLOYMENT"
    : `Automatic re-execution of CCIP FAILUREs: ${worker}`;
  const encoded = JSON.parse(encodeDeployment(deployment)) as Record<string, unknown>;
  // the vars it goes into (a var holds 5 kB): DEPLOYMENT, and the for-life list's parts when it doesn't fit one
  const vars = splitDeploymentVars(encoded);
  // never print vars the Worker wouldn't read back as this deployment (the R13 review's Low 3): join them as it does
  const joined = joinDeploymentVars(vars);
  if (joined.text === undefined) throw new Error(`the deployment's vars don't join back: ${joined.problems.join("; ")}; nothing printed`);
  if (encodeDeployment(decodeDeployment(joined.text)) !== encodeDeployment(decodeDeployment(JSON.stringify(encoded)))) throw new Error("the deployment's vars join back to another deployment than the record's; nothing printed");
  return { deployment, caps, reexec, text: JSON.stringify(encoded, null, 2), vars, varsText: varsText(vars) };
}

/** The vars as wrangler.jsonc's members: each `"NAME": { … },` (from column 0; indent them as the file's vars are), to
 * paste over the environment's DEPLOYMENT line and every DEPLOYMENT_FOR_LIFE_ line after it. */
export function varsText(vars: Record<string, unknown>): string {
  return Object.entries(vars)
    .map(([name, v]) => `${JSON.stringify(name)}: ${JSON.stringify(v, null, 2)},`)
    .join("\n");
}

if (isMain(import.meta.url)) {
  const a = argsOf(
    process.argv.slice(2).filter((x) => x !== "--"),
    ["--name"],
  );
  const path = a.positional[0];
  if (!path) {
    console.error("usage: pnpm config:from-record -- <record.json> [--name <deployment>] [--rehearsal]");
    process.exitCode = 2;
  } else {
    const live = !a.flag("--rehearsal");
    const rec = loadRecordV32For(resolve(path), live);
    if (!rec) throw new Error(`no ${live ? "live" : "rehearsal"} v3.2 record at ${path}`);
    const t = live ? targets(process.env).live : targets(process.env).rehearsal;
    const name = a.value("--name") ?? basename(path).replace(/^rehearsal-/, "").replace(/\.json$/, "");
    configFromRecord({ rec, name, rpc: createRpc(t), env: process.env }).then(
      (r) => {
        console.error(r.reexec);
        const n = Object.keys(r.vars).length - 1;
        const parts = n ? ` and its for-life list in ${n} part${n === 1 ? "" : "s"} (a var holds 5 kB; the Worker joins them)` : "";
        console.error(`The ${name} deployment, for wrangler.jsonc's vars: DEPLOYMENT${parts}. Paste them over the environment's DEPLOYMENT line${n ? " and any DEPLOYMENT_FOR_LIFE_ lines" : ""} (keeper ${r.deployment.keeper}; ${r.caps}):`);
        console.log(r.varsText);
      },
      (e: unknown) => {
        console.error(`Stopped: ${(e as Error).message}`);
        process.exitCode = 1;
      },
    );
  }
}
