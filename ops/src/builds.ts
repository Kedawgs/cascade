import { readFileSync } from "node:fs";
import type { Artifact } from "./artifacts.ts";
import { A2B4412_BUILD, buildOf, type PlanV3 } from "./plan.ts";

type Code = Pick<Artifact, "deployedBytecode" | "immutableRanges">;

/** The contracts whose deployed code differs between the a2b4412 build and this one: the 7-day cap on
 * the batch interval changed CascadeFrontDoor, and CascadeStaker (which imports it) differs in its
 * metadata hash. The adapters, the vault and the oracle are byte-identical in both builds. */
export const A2B4412_DIFFERS = ["CascadeFrontDoor", "CascadeStaker"] as const;

let a2b4412: Record<string, Code> | undefined;

/** One of those two contracts as the a2b4412 build compiled it: runtime code and that build's own
 * immutable positions (ops/builds/a2b4412.json, from `git archive a2b4412 contracts` built with the same
 * foundry.toml). */
export function a2b4412Code(name: (typeof A2B4412_DIFFERS)[number]): Code {
  a2b4412 ??= Object.fromEntries(
    Object.entries(
      (
        JSON.parse(readFileSync(new URL("../builds/a2b4412.json", import.meta.url), "utf8")) as {
          contracts: Record<string, { deployedBytecode: Artifact["deployedBytecode"]; immutableReferences: Record<string, Artifact["immutableRanges"]> }>;
        }
      ).contracts,
    ).map(([n, c]) => [n, { deployedBytecode: c.deployedBytecode, immutableRanges: Object.values(c.immutableReferences).flat() }]),
  );
  const code = a2b4412[name];
  if (!code) throw new Error(`ops/builds/a2b4412.json has no ${name}`);
  return code;
}

/** The code a v3 plan's contract must match: the build the plan was deployed from (a plan with no
 * `build` is a2b4412's, for the two contracts that build differs in), otherwise this build's
 * contracts/out (`current`). Refuses a build this tool does not know. */
export function codeFor(plan: PlanV3, name: string, current: (name: string) => Code): Code {
  const differs = (A2B4412_DIFFERS as readonly string[]).includes(name);
  return buildOf(plan) === A2B4412_BUILD && differs ? a2b4412Code(name as (typeof A2B4412_DIFFERS)[number]) : current(name);
}
