import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Abi, Hex } from "viem";

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableRanges: { start: number; length: number }[];
}

/** Reads a contract's build output from contracts/out (run `forge build` first). */
export function loadArtifact(contractsDir: string, name: string): Artifact {
  const source = name.startsWith("Rehearsal") || name === "ForceSend" ? "RehearsalPrecompiles.sol" : `${name}.sol`;
  const json = JSON.parse(readFileSync(join(contractsDir, "out", source, `${name}.json`), "utf8"));
  const refs: Record<string, { start: number; length: number }[]> = json.deployedBytecode.immutableReferences ?? {};
  return {
    abi: json.abi,
    bytecode: json.bytecode.object,
    deployedBytecode: json.deployedBytecode.object,
    immutableRanges: Object.values(refs).flat(),
  };
}

/** Zeroes each byte range, so code with different immutables compares equal. */
export function maskImmutables(code: Hex, ranges: { start: number; length: number }[]): Hex {
  const bytes = code.slice(2).split("");
  for (const { start, length } of ranges) {
    for (let i = start * 2; i < (start + length) * 2 && i < bytes.length; i++) bytes[i] = "0";
  }
  return `0x${bytes.join("")}`;
}
