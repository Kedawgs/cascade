import { describe, expect, it } from "vitest";
import {
  maxStakeInput,
  maxUnstakeInput,
  stakeButtonLabel,
  unstakeButtonLabel,
  validateStakeAmount,
} from "./stake-form";
import { parseAmount, sanitizeAmountInput } from "./format";

const limits = { minUsd: 10, maxUsd: 50_000 };

describe("validateStakeAmount", () => {
  it("accepts amounts within limits", () => {
    expect(validateStakeAmount(500, limits)).toBeNull();
    expect(validateStakeAmount(null, limits)).toBeNull();
  });

  it("rejects below and above the limits in plain words", () => {
    expect(validateStakeAmount(5, limits)).toBe("The smallest stake is $10.");
    expect(validateStakeAmount(50_001, limits)).toBe("The most you can stake right now is $50,000.");
  });

  it("copes with pasted and odd input through the sanitizer", () => {
    expect(validateStakeAmount(parseAmount(sanitizeAmountInput("$1,000", 2)), limits)).toBeNull();
    expect(parseAmount(sanitizeAmountInput("1e5", 2))).toBe(15);
    expect(parseAmount(sanitizeAmountInput("0.", 2))).toBe(0);
    expect(validateStakeAmount(0, limits)).toBe("The smallest stake is $10.");
  });
});

describe("stakeButtonLabel", () => {
  it("asks to connect first", () => {
    expect(stakeButtonLabel({ account: null, amount: 500, error: null, pending: false })).toBe(
      "Connect wallet",
    );
  });

  it("names the amount once it is valid", () => {
    expect(stakeButtonLabel({ account: "0xa", amount: 500, error: null, pending: false })).toBe(
      "Stake 500 USDC",
    );
    expect(stakeButtonLabel({ account: "0xa", amount: 1234.5, error: null, pending: false })).toBe(
      "Stake 1,234.50 USDC",
    );
  });

  it("falls back to the bare verb and shows progress", () => {
    expect(stakeButtonLabel({ account: "0xa", amount: null, error: null, pending: false })).toBe("Stake");
    expect(stakeButtonLabel({ account: "0xa", amount: 5, error: "too small", pending: false })).toBe(
      "Stake",
    );
    expect(stakeButtonLabel({ account: "0xa", amount: 500, error: null, pending: true })).toBe(
      "Confirm in your wallet…",
    );
  });
});

describe("unstake helpers", () => {
  it("labels the button", () => {
    expect(unstakeButtonLabel({ account: null, amount: 1, error: null, pending: false })).toBe(
      "Connect wallet",
    );
    expect(unstakeButtonLabel({ account: "0xa", amount: 1.5, error: null, pending: false })).toBe(
      "Unstake 1.50 TAO",
    );
    expect(unstakeButtonLabel({ account: "0xa", amount: null, error: null, pending: false })).toBe(
      "Unstake",
    );
  });

  it("shows progress while the wallet asks", () => {
    expect(unstakeButtonLabel({ account: "0xa", amount: 1, error: null, pending: true })).toBe("Confirm in your wallet…");
  });

  it("fills MAX with the exact available TAO, floored to six decimals", () => {
    expect(maxUnstakeInput(788n * 10n ** 14n)).toBe("0.0788");
    expect(maxUnstakeInput(1_234_567_891n * 10n ** 9n)).toBe("1.234567");
    expect(maxUnstakeInput(0n)).toBe("0");
  });
});

describe("balance checks", () => {
  it("refuses more than the wallet holds", () => {
    expect(validateStakeAmount(10_000, limits, 2400)).toBe("You have 2,400 USDC on Base.");
    expect(validateStakeAmount(2400, limits, 2400)).toBeNull();
    expect(validateStakeAmount(500, limits, null)).toBeNull();
    expect(validateStakeAmount(5, limits, 2400)).toBe("The smallest stake is $10.");
  });

  it("floors MAX to whole cents so it never exceeds the balance", () => {
    expect(maxStakeInput(2.999999)).toBe("2.99");
    expect(maxStakeInput(12.345678)).toBe("12.34");
    expect(maxStakeInput(2400)).toBe("2400.00");
  });
});
