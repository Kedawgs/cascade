import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { CADENCE } from "./config.ts";
import { cadenceOf, closeMaxWaitS, isPlanV3, settingsV3Of } from "./plan.ts";
import { type DeploymentRecord, type DoneStep, requireHandoff } from "./record.ts";
import { encodeSs58 } from "./ss58.ts";
import { isPlanV32, type PlanV32, type V32StepId } from "./v32/plan.ts";

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
 * https origin (`env`), the site is told to start its history scans from the indexer's seed. A v3.2
 * deployment's are webEnvV32's. */
export function webEnv(rec: DeploymentRecord | WebRecordV32, env: Record<string, string | undefined> = process.env): string {
  if (isV32Record(rec)) return webEnvV32(rec, env);
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

/** What web-config needs of a v3.2 deployment's record (Task 44 writes it): its plan, the steps done (the Bittensor
 * adapter's deploy block, where the site's history scans start) and its read-back. */
export interface WebRecordV32 {
  plan: PlanV32;
  done: Partial<Record<V32StepId, DoneStep>>;
  verify?: { ok: boolean };
}

const isV32Record = (rec: DeploymentRecord | WebRecordV32): rec is WebRecordV32 => isPlanV32(rec.plan);

/** The site's settings for a verified v3.2 deployment (webEnv's, plus): both lenses, which web/ reads v3.2's moved
 * getters through (NEXT_PUBLIC_CASCADE_VAULT_LENS, _DOOR_LENS); the vault's coldkey, hotkey and payout delay from its
 * constructor's Params, as deployed; the launch cadence's maximum batch wait (v3.2 is the launch); and the history
 * indexer, which a v3.2 site reads the outside price from before every stake and USDC unstake, so the site refuses to
 * build without it, and so does this. Ownership is the constructor's (no hand-off from a test wallet). */
function webEnvV32(rec: WebRecordV32, env: Record<string, string | undefined>): string {
  if (!rec.verify?.ok) throw new Error("the deployment's read-back has not passed: run verify first");
  const a = rec.plan.addresses;
  const bit = rec.done.bitAdapter;
  if (!bit || !("block" in bit) || bit.block === undefined) throw new Error("the Bittensor adapter's deploy block is not in the record");
  const indexer = indexerOrigin(env.OPS_INDEXER_URL);
  if (!indexer) throw new Error("a v3.2 site needs the history indexer: set OPS_INDEXER_URL to its https origin (no path); nothing written");
  const p = rec.plan.steps.find((s) => s.id === "vault")!.args[0] as { expectedColdkey: Hex; hotkey: Hex; payoutDelay: bigint };
  return [
    "# Written by `pnpm ops web-config`: the live v3.2 deployment. Local only (git-ignored).",
    `NEXT_PUBLIC_CASCADE_FRONT_DOOR=${a.frontDoor}`,
    `NEXT_PUBLIC_CASCADE_BASE_ADAPTER=${a.baseAdapter}`,
    `NEXT_PUBLIC_CASCADE_STAKER=${a.staker}`,
    `NEXT_PUBLIC_CASCADE_ORACLE=${a.oracle}`,
    `NEXT_PUBLIC_CASCADE_VAULT=${a.vault}`,
    `NEXT_PUBLIC_CASCADE_BIT_ADAPTER=${a.bitAdapter}`,
    `NEXT_PUBLIC_CASCADE_BIT_BLOCK=${bit.block}`,
    `NEXT_PUBLIC_CASCADE_VAULT_SS58=${encodeSs58(p.expectedColdkey)}`,
    `NEXT_PUBLIC_CASCADE_HOTKEY_SS58=${encodeSs58(p.hotkey)}`,
    `NEXT_PUBLIC_CASCADE_VAULT_LENS=${a.vaultLens}`,
    `NEXT_PUBLIC_CASCADE_DOOR_LENS=${a.doorLens}`,
    `NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S=${p.payoutDelay}`,
    `NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S=${CADENCE.launch.closeMaxWaitS}`,
    `NEXT_PUBLIC_CASCADE_INDEXER_URL=${indexer}`,
    "",
  ].join("\n");
}

export function writeWebEnv(rec: DeploymentRecord | WebRecordV32, repoRoot: string, env: Record<string, string | undefined> = process.env): string {
  const path = join(repoRoot, "web", ".env.local");
  writeFileSync(path, webEnv(rec, env));
  return path;
}
