import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { PREAUDIT_CONTRACTS, preauditArtifact } from "../src/builds.ts";
import type { Runner } from "../src/send.ts";

/** CascadeBase's getters, which v3.2's Task 5d-1 took out of the vault's and the front door's ABI. */
const BASE_GETTERS = ["guardian", "pendingGuardian", "guardianProposedAt", "bridgeEnabled", "bridgeProposedAt", "primaryBridge"];

/** A contracts checkout (a directory with an out/ as forge writes it) holding the six contracts of
 * v3-launch's frozen build; with `other`, another build instead: each runtime code one byte off and
 * none of CascadeBase's getters in the ABI, as contracts/out holds v3.2's. Removed when the test that
 * made it finishes. */
export function checkoutOf(other = false): string {
  const dir = mkdtempSync(join(tmpdir(), other ? "ops-other-build-" : "ops-preaudit-build-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeOut(dir, other);
  return dir;
}

/** What a build of a checkout's sources gives: the frozen build's ("frozen"), another ("other"), or a
 * failed compile ("fails"). */
export type Sources = "frozen" | "other" | "fails";

/** A runner standing in for Foundry, which records every run as [tool, ...args, cwd]: its `forge build`
 * writes the build of `sources` into the checkout's out/, as forge would (a stale out/ is replaced),
 * or fails; any other run fails ("not in tests"). */
export function buildingRunner(sources: Sources, runs: string[][]): Runner {
  return {
    run: async (file, args, opts) => {
      const tool = file.replace(/\\/g, "/").split("/").pop()!.replace(/\.exe$/, "");
      runs.push([tool, ...args, opts.cwd]);
      if (tool !== "forge" || args[0] !== "build") return { code: 1, stdout: "", stderr: "not in tests" };
      if (sources === "fails") return { code: 1, stdout: "", stderr: "Error: Compiler run failed:\nError (7576): Undeclared identifier." };
      writeOut(opts.cwd, sources === "other");
      return { code: 0, stdout: "Compiler run successful!", stderr: "" };
    },
  };
}

/** Writes the six contracts' artifacts into `dir`/out/: the frozen build's, or with `other` another's. */
function writeOut(dir: string, other: boolean): void {
  for (const n of PREAUDIT_CONTRACTS) {
    const a = preauditArtifact(n);
    const code = other ? `${a.deployedBytecode.slice(0, -2)}${a.deployedBytecode.endsWith("00") ? "01" : "00"}` : a.deployedBytecode;
    const abi = other ? a.abi.filter((i) => !(i.type === "function" && BASE_GETTERS.includes(i.name))) : a.abi;
    mkdirSync(join(dir, "out", `${n}.sol`), { recursive: true });
    writeFileSync(
      join(dir, "out", `${n}.sol`, `${n}.json`),
      JSON.stringify({ abi, bytecode: { object: a.bytecode }, deployedBytecode: { object: code, immutableReferences: { 1: a.immutableRanges } } }),
    );
  }
}
