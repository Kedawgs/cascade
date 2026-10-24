import { describe, expect, it } from "vitest";
import {
  stakeButtonLabel,
  unstakeButtonLabel,
  validateStakeAmount,
  validateUnstakeAmount,
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
      "Starting your stake…",
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

  it("validates against the staked balance", () => {
    expect(validateUnstakeAmount(4, 3.66)).toBe("You have 3.66 TAO staked.");
    expect(validateUnstakeAmount(0, 3.66)).toBe("Enter how much TAO to unstake.");
    expect(validateUnstakeAmount(1, 3.66)).toBeNull();
    expect(validateUnstakeAmount(null, 3.66)).toBeNull();
  });
});
