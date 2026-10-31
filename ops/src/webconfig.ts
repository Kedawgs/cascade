import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { cadenceOf, closeMaxWaitS, isPlanV3, settingsV3Of } from "./plan.ts";
import { type DeploymentRecord, requireHandoff } from "./record.ts";
import { encodeSs58 } from "./ss58.ts";

/** `v` as the history indexer's origin: exactly an https origin (scheme and host, a port at most), else null.
 * The same rule as the site's (web/src/lib/cascade/config.ts, indexerOrigin), so what is written is what the
 * site will use. */
export function indexerOrigin(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" && url.origin === v && HOSTNAME.test(url.hostname) ? v : null;
  } catch {
    return null;
  }
}

/** A DNS name: labels of letters, digits and hyphens (no wildcard, which the URL parser lets through). */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** The site's settings for a verified deployment, as `web/.env.local` lines (all public values). A v3
 * deployment adds the staker, the oracle and the vault's payout delay (from the plan's cadence); the
 * validator is the one the vault was deployed with. With OPS_INDEXER_URL set to the history indexer's
 * https origin (`env`), the site is told to start its history scans from the indexer's seed. */
export function webEnv(rec: DeploymentRecord, env: Record<string, string | undefined> = process.env): string {
  if (!rec.verify?.ok) throw new Error("the deployment's read-back has not passed: run verify first");
  // a launch goes public only once its final owners hold it, not the test wallet
  requireHandoff(rec);
  const plan = rec.plan;
  const a = plan.addresses;
  const bit = rec.done.bitAdapter;
  if (!bit || !("block" in bit) || bit.block === undefined) throw new Error("the Bittensor adapter's deploy block is not in the record");
  const [coldkey, hotkey] = plan.steps.find((s) => s.id === "vault")!.args as [Hex, Hex];
  return [
    "# Written by `pnpm ops web-config`: the live " + cadenceOf(plan) + " deployment. Local only (git-ignored).",
    `NEXT_PUBLIC_CASCADE_FRONT_DOOR=${a.frontDoor}`,
    `NEXT_PUBLIC_CASCADE_BASE_ADAPTER=${a.baseAdapter}`,
    ...(isPlanV3(plan) ? [`NEXT_PUBLIC_CASCADE_STAKER=${plan.addresses.staker}`, `NEXT_PUBLIC_CASCADE_ORACLE=${plan.addresses.oracle}`] : []),
    `NEXT_PUBLIC_CASCADE_VAULT=${a.vault}`,
    `NEXT_PUBLIC_CASCADE_BIT_ADAPTER=${a.bitAdapter}`,
    `NEXT_PUBLIC_CASCADE_BIT_BLOCK=${bit.block}`,
    `NEXT_PUBLIC_CASCADE_VAULT_SS58=${encodeSs58(coldkey)}`,
    `NEXT_PUBLIC_CASCADE_HOTKEY_SS58=${encodeSs58(hotkey)}`,
    ...(isPlanV3(plan) ? [`NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S=${settingsV3Of(plan).payoutDelay}`] : []),
    ...(cadenceOf(plan) === "launch" ? [`NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S=${closeMaxWaitS(plan)}`] : []),
    ...(indexerOrigin(env.OPS_INDEXER_URL) ? [`NEXT_PUBLIC_CASCADE_INDEXER_URL=${indexerOrigin(env.OPS_INDEXER_URL)}`] : []),
    "",
  ].join("\n");
}

export function writeWebEnv(rec: DeploymentRecord, repoRoot: string, env: Record<string, string | undefined> = process.env): string {
  const path = join(repoRoot, "web", ".env.local");
  writeFileSync(path, webEnv(rec, env));
  return path;
}
