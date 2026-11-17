import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARGIN_FALLBACK_S, REREAD_S, SETTLE_S, WINDOW } from "../../src/scan.ts";
import { pkg } from "./files.ts";

/** A `NAME: Record<ChainName, bigint> = { base: 70n, bittensor: 400n }` constant in the keeper's scan. */
function keeperConstant(source: string, name: string): { base: bigint; bittensor: bigint } {
  const m = new RegExp(`\\b${name}\\b[^=]*=\\s*\\{\\s*base:\\s*([\\d_]+)n,\\s*bittensor:\\s*([\\d_]+)n\\s*\\}`).exec(source);
  if (!m) throw new Error(`no ${name} in ops/src/keeper/core/logs.ts`);
  return { base: BigInt(m[1].replaceAll("_", "")), bittensor: BigInt(m[2].replaceAll("_", "")) };
}

/** A `NAME: Record<ChainName, number> = { base: 140, bittensor: 4_800 }` constant (seconds) in the keeper. */
function keeperSeconds(source: string, name: string): { base: number; bittensor: number } {
  const m = new RegExp(`\\b${name}\\b[^=]*=\\s*\\{\\s*base:\\s*([\\d_.]+),\\s*bittensor:\\s*([\\d_.]+)\\s*\\}`).exec(source);
  if (!m) throw new Error(`no ${name} in the keeper`);
  return { base: Number(m[1].replaceAll("_", "")), bittensor: Number(m[2].replaceAll("_", "")) };
}

describe("the scan's numbers are the keeper's", () => {
  const state = readFileSync(pkg("../ops/src/keeper/core/logs.ts"), "utf8");
  const blocktime = readFileSync(pkg("../ops/src/keeper/core/blocktime.ts"), "utf8");

  it("the re-read and settle margins, in seconds (the v3.2 keeper core's and the scan's, each counted at its chain's measured block time), and the block times they are counted at while a chain's is unread", () => {
    expect(REREAD_S).toEqual(keeperSeconds(state, "REREAD_S"));
    expect(SETTLE_S).toEqual(keeperSeconds(state, "SETTLE_S"));
    expect(MARGIN_FALLBACK_S).toEqual(keeperSeconds(blocktime, "MARGIN_FALLBACK_S"));
  });

  it("the windows (Base's is the default; BASE_LOG_WINDOW can change it)", () => {
    expect(WINDOW).toEqual(keeperConstant(state, "WINDOW"));
  });
});
