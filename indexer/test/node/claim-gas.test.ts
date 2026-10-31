import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/thresholds.ts";
import { pkg } from "./files.ts";

// keeper.low_tao's floor is a claim's gas up front: (the vault's claimGasRequired + the keeper's margin) × the base
// fee. The margin must be the one the keeper sends a claim with (ops/src/keeper/rewards.ts).

describe("keeper.low_tao's claim gas is the keeper's", () => {
  it("claimGasMargin is ops' CLAIM_GAS_MARGIN, and a claim is sent with claimGasRequired plus it", () => {
    const rewards = readFileSync(pkg("../ops/src/keeper/rewards.ts"), "utf8");
    const m = /\bCLAIM_GAS_MARGIN\s*=\s*([\d_]+)n/.exec(rewards);
    expect(m).not.toBeNull();
    expect(DEFAULTS.claimGasMargin).toBe(Number((m as RegExpExecArray)[1].replaceAll("_", "")));
    expect(rewards).toMatch(/claimGasLimit = \(claimGasRequired: bigint\) => claimGasRequired \+ CLAIM_GAS_MARGIN/);
  });
});
