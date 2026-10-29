import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REREAD, SETTLE, WINDOW } from "../../src/scan.ts";
import { pkg } from "./files.ts";

/** A `NAME: Record<ChainName, bigint> = { base: 70n, bittensor: 400n }` constant in the keeper's scan. */
function keeperConstant(source: string, name: string): { base: bigint; bittensor: bigint } {
  const m = new RegExp(`\\b${name}\\b[^=]*=\\s*\\{\\s*base:\\s*([\\d_]+)n,\\s*bittensor:\\s*([\\d_]+)n\\s*\\}`).exec(source);
  if (!m) throw new Error(`no ${name} in ops/src/keeper/state.ts`);
  return { base: BigInt(m[1].replaceAll("_", "")), bittensor: BigInt(m[2].replaceAll("_", "")) };
}

describe("the scan's numbers are the keeper's", () => {
  const state = readFileSync(pkg("../ops/src/keeper/state.ts"), "utf8");

  it("REREAD and SETTLE", () => {
    expect(REREAD).toEqual(keeperConstant(state, "REREAD"));
    expect(SETTLE).toEqual(keeperConstant(state, "SETTLE"));
  });

  it("the windows (Base's is the default; BASE_LOG_WINDOW can change it)", () => {
    expect(WINDOW).toEqual(keeperConstant(state, "WINDOW"));
  });
});
