import { readFileSync } from "node:fs";
import { type Artifact, loadArtifact, maskImmutables } from "./artifacts.ts";
import { A2B4412_BUILD, buildOf, CONTRACTS_BUILD, type ContractsBuild, isPlanV3, type Plan, type PlanV3 } from "./plan.ts";

type Code = Pick<Artifact, "deployedBytecode" | "immutableRanges">;

// Which build a plan's contracts are read from. contracts/ holds v3.2 from v3.2's Task 2 on, so
// contracts/out is no longer the build any plan this tool knows was deployed from: v3-launch's build
// ("preaudit") is frozen in ops/builds/preaudit/build.json (v3.2's Task 5a), with v3-test's
// ("a2b4412") in ops/builds/a2b4412.json for the contracts it differs in. Every read of a plan's
// contracts (ABI, creation code, runtime code, immutable positions) goes through artifactFor, which
// routes by the plan's build; v3.2's builds will route to contracts/out (or the published merged ABI)
// there, in Tasks 43a and 44.

/** The six contracts of v3-launch's build. */
export const PREAUDIT_CONTRACTS = ["CcipBaseAdapter", "CascadeTwapOracle", "CascadeFrontDoor", "CascadeStaker", "CcipBittensorAdapter", "CascadeVault"] as const;

let preaudit: Record<string, Artifact> | undefined;

/** One of v3-launch's contracts as its frozen build has it (ops/builds/preaudit/build.json, from
 * d21daf3's contracts): ABI, creation code, runtime code and immutable positions. */
export function preauditArtifact(name: string): Artifact {
  preaudit ??= Object.fromEntries(
    Object.entries(
      (
        JSON.parse(readFileSync(new URL("../builds/preaudit/build.json", import.meta.url), "utf8")) as {
          contracts: Record<
            string,
            { abi: Artifact["abi"]; bytecode: Artifact["bytecode"]; deployedBytecode: Artifact["deployedBytecode"]; immutableReferences: Record<string, Artifact["immutableRanges"]> }
          >;
        }
      ).contracts,
    ).map(([n, c]) => [n, { abi: c.abi, bytecode: c.bytecode, deployedBytecode: c.deployedBytecode, immutableRanges: Object.values(c.immutableReferences).flat() }]),
  );
  const a = preaudit[name];
  if (!a) throw new Error(`ops/builds/preaudit/build.json has no ${name}`);
  return a;
}

/** The contracts whose deployed code differs between the a2b4412 build and this one: the 7-day cap on
 * the batch interval (the launch-cadence build) changed CascadeFrontDoor, and CascadeStaker (which
 * imports it) differs in its metadata hash; the pre-audit changes changed both adapters (a per-message
 * cap in their Config) and the vault (the allowance base, setter bounds, the redeem minimum). Only the
 * oracle is byte-identical in both builds. */
export const A2B4412_DIFFERS = ["CcipBaseAdapter", "CascadeFrontDoor", "CascadeStaker", "CcipBittensorAdapter", "CascadeVault"] as const;

let a2b4412: Record<string, Code> | undefined;

/** One of those contracts as the a2b4412 build compiled it: runtime code and that build's own immutable
 * positions (ops/builds/a2b4412.json, from `git archive a2b4412 contracts` built with the same
 * foundry.toml and fully initialised libs, whose remappings are in the metadata hash). */
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

/** A plan's contract as the build the plan was deployed from has it: its ABI, creation code, runtime
 * code and immutable positions. Every plan this tool knows predates v3.2 and reads v3-launch's frozen
 * build, as it read contracts/out before contracts/ held v3.2: a preaudit plan (v3-launch), a v2 plan,
 * and an a2b4412 plan (v3-test), whose contracts that build differs in take their runtime code and
 * immutable positions from a2b4412.json (their ABI and creation code are the frozen build's, as
 * before; an unfinished a2b4412 plan is never resumed, so that creation code is never sent). Refuses
 * a build this tool does not know. Never reads contracts/out. */
export function artifactFor(plan: Plan | PlanV3, name: string): Artifact {
  const frozen = preauditArtifact(name);
  if (!isPlanV3(plan)) return frozen;
  const differs = (A2B4412_DIFFERS as readonly string[]).includes(name);
  return buildOf(plan) === A2B4412_BUILD && differs ? { ...frozen, ...a2b4412Code(name as (typeof A2B4412_DIFFERS)[number]) } : frozen;
}

/** The code a v3 plan's contract must match: artifactFor's runtime code and immutable positions. */
export const codeFor = (plan: PlanV3, name: string): Code => artifactFor(plan, name);

/** The contracts of `build` whose runtime code in this checkout's contracts/out (immutables masked)
 * differs from the build's own, or that contracts/out lacks; [] when the checkout is that build. A
 * create sends this checkout's code (`forge create` builds contracts/), so a plan's creates go only
 * from a checkout of its build. */
export function checkoutDiffers(contractsDir: string, build: ContractsBuild): string[] {
  if (build !== CONTRACTS_BUILD) return [...PREAUDIT_CONTRACTS];
  return PREAUDIT_CONTRACTS.filter((n) => {
    const want = preauditArtifact(n);
    try {
      const got = loadArtifact(contractsDir, n);
      return maskImmutables(got.deployedBytecode, got.immutableRanges) !== maskImmutables(want.deployedBytecode, want.immutableRanges);
    } catch {
      return true;
    }
  });
}

/** Throws, sending nothing, unless this checkout's contracts/out is `build` (see checkoutDiffers). */
export function assertCheckoutIs(contractsDir: string, build: ContractsBuild): void {
  const differ = checkoutDiffers(contractsDir, build);
  if (differ.length) {
    throw new Error(
      `this checkout's contracts are not the ${build} build its plans deploy (ops/builds/${build === CONTRACTS_BUILD ? "preaudit/build.json" : "a2b4412.json"}): ${differ.join(", ")} differ in contracts/out, and a create sends this checkout's code; deploy a ${build} plan from a checkout of that build; nothing sent`,
    );
  }
}
