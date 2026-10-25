import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { SETTINGS } from "./config.ts";
import type { DeploymentRecord } from "./record.ts";
import { encodeSs58 } from "./ss58.ts";

/** The site's settings for a verified deployment, as `web/.env.local` lines (all public values). */
export function webEnv(rec: DeploymentRecord): string {
  if (!rec.verify?.ok) throw new Error("the deployment's read-back has not passed: run verify first");
  const a = rec.plan.addresses;
  const bit = rec.done.bitAdapter;
  if (!bit || !("block" in bit)) throw new Error("the Bittensor adapter's deploy block is not in the record");
  const coldkey = rec.plan.steps.find((s) => s.id === "vault")!.args[0] as Hex;
  return [
    "# Written by `pnpm ops web-config`: the live test deployment. Local only (git-ignored).",
    `NEXT_PUBLIC_CASCADE_FRONT_DOOR=${a.frontDoor}`,
    `NEXT_PUBLIC_CASCADE_BASE_ADAPTER=${a.baseAdapter}`,
    `NEXT_PUBLIC_CASCADE_VAULT=${a.vault}`,
    `NEXT_PUBLIC_CASCADE_BIT_ADAPTER=${a.bitAdapter}`,
    `NEXT_PUBLIC_CASCADE_BIT_BLOCK=${bit.block}`,
    `NEXT_PUBLIC_CASCADE_VAULT_SS58=${encodeSs58(coldkey)}`,
    `NEXT_PUBLIC_CASCADE_HOTKEY_SS58=${encodeSs58(SETTINGS.hotkey)}`,
    "",
  ].join("\n");
}

export function writeWebEnv(rec: DeploymentRecord, repoRoot: string): string {
  const path = join(repoRoot, "web", ".env.local");
  writeFileSync(path, webEnv(rec));
  return path;
}
