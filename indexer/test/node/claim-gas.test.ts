import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/thresholds.ts";
import { pkg } from "./files.ts";

// keeper.low_tao's floor is a claim's gas up front: (the vault's claimGasRequired + the keeper's margin), held to
// Bittensor's per-transaction ceiling, × the base fee. The margin and the ceiling must be the ones the keeper sends a
// claim with (ops/src/keeper/core/rewards.ts, ops/src/keeper/core/ceiling.ts; Task 65).

describe("keeper.low_tao's claim gas is the keeper's", () => {
  it("claimGasMargin is ops' CLAIM_GAS_MARGIN and claimGasCeiling ops' BITTENSOR_TX_GAS_CEILING: a claim is sent with claimGasRequired plus the margin, held to the ceiling (Task 65)", () => {
    const rewards = readFileSync(pkg("../ops/src/keeper/core/rewards.ts"), "utf8");
    const m = /\bCLAIM_GAS_MARGIN\s*=\s*([\d_]+)n/.exec(rewards);
    expect(m).not.toBeNull();
    expect(DEFAULTS.claimGasMargin).toBe(Number((m as RegExpExecArray)[1].replaceAll("_", "")));
    expect(rewards).toMatch(/claimGasLimit = \(claimGasRequired: bigint\): bigint => underCeiling\(claimGasRequired \+ CLAIM_GAS_MARGIN\)/);
    const ceiling = readFileSync(pkg("../ops/src/keeper/core/ceiling.ts"), "utf8");
    const c = /\bBITTENSOR_TX_GAS_CEILING\s*=\s*([\d_]+)n/.exec(ceiling);
    expect(c).not.toBeNull();
    expect(DEFAULTS.claimGasCeiling).toBe(Number((c as RegExpExecArray)[1].replaceAll("_", "")));
    expect(ceiling).toMatch(/underCeiling = \(gas: bigint\): bigint => \(gas > BITTENSOR_TX_GAS_CEILING \? BITTENSOR_TX_GAS_CEILING : gas\)/);
  });
});
