import { describe, expect, it } from "vitest";
import { type BudgetInputs, computeBudget, formatBudget } from "../src/budget.ts";

const inputs: BudgetInputs = {
  bitCreateGas: { bitAdapter: 1_835_528n, vault: 6_038_421n },
  bitConfigGas: 300_000n,
  baseDeployGas: 5_000_000n,
  closeGas: 400_000n,
  bitGasPrice: 5_000_000_000n,
  baseGasPrice: 6_000_000n,
  baseFeeQuote: 619_000_000_000_000n,
  taoBalance: 7_999_500_000_000_000n,
  ethBalance: 0n,
};

describe("budget", () => {
  it("computes the needs and the one top-up from the formula", () => {
    const b = computeBudget(inputs);
    // TAO: (1,835,528 + 6,038,421 + 300,000 + 2×500,000 + 3,000,000 + 30,000) gas × 5 gwei
    //      = 61,019,745e9 wei, + 1e12 + 1.5e12 reserves = 61,022,245,000,000,000; × 1.3 = 79,328,918,500,000,000
    expect(b.taoNeed).toBe(79_328_918_500_000_000n);
    // minus 0.0079995 held = 71,329,418,500,000,000, rounded up to 0.001 TAO = 0.072
    expect(b.taoToSend).toBe(72_000_000_000_000_000n);
    // ETH: (5,000,000 + 3×400,000) gas × 0.006 gwei = 3.72e13; + 3 × 6.19e14 × 1.25 = 2.32125e15;
    //      sum 2.35845e15 × 1.3 = 3.065985e15; + 2e14 L1 allowance = 3.265985e15
    expect(b.ethNeed).toBe(3_265_985_000_000_000n);
    expect(b.ethToSend).toBe(3_300_000_000_000_000n);
  });

  it("asks for nothing when the wallet already holds enough", () => {
    const b = computeBudget({ ...inputs, taoBalance: 10n ** 18n, ethBalance: 10n ** 18n });
    expect([b.taoToSend, b.ethToSend]).toEqual([0n, 0n]);
  });

  it("names each destination with its chain", () => {
    const lines = formatBudget(computeBudget(inputs));
    expect(lines).toContain(
      "Send 0.072 TAO to the test wallet's Bittensor address 5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2",
    );
    expect(lines).toContain("Send 0.0033 ETH on Base to 0x770932787DD3bcE64f14E31f4746bCe22E214fFF");
  });
});
