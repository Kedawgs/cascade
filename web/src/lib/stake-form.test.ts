import { describe, expect, it } from "vitest";
import {
  maxStakeInput,
  maxUnstakeInput,
  maxUnstakeInputIn,
  stakeButtonLabel,
  switchUnstakeUnit,
  unstakeErrorText,
  unstakeLabelUsd,
  unstakeNote,
  unstakeButtonLabel,
  unstakeEquivalent,
  unstakeRequestWei,
  validateStakeAmount,
} from "./stake-form";
import { formatUsdcCents, parseAmount, sanitizeAmountInput } from "./format";

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

  it("names the amount typed to six decimals, never rounding up", () => {
    const ok = { account: "0xa", error: null, pending: false };
    expect(unstakeButtonLabel({ ...ok, amount: 0.005 })).toBe("Unstake 0.005 TAO");
    expect(unstakeButtonLabel({ ...ok, amount: 0.12345 })).toBe("Unstake 0.12345 TAO");
    expect(unstakeButtonLabel({ ...ok, amount: 0.090086006 })).toBe("Unstake 0.090086 TAO");
  });

  it("names a USDC-typed unstake in dollars", () => {
    expect(unstakeButtonLabel({ account: "0xa", amount: 0.039619, usd: 10, error: null, pending: false })).toBe("Unstake $10.00");
  });

  it("prices the dollar label from the TAO actually sent when the amount is fixed (switched or MAX)", () => {
    expect(unstakeLabelUsd({ unit: "USDC", raw: "252.40", fixed: true, requestWei: 10n ** 18n, priceUsd: 260 })).toBe(260);
    expect(unstakeLabelUsd({ unit: "USDC", raw: "10", fixed: false, requestWei: 39_619_651_000_000_000n, priceUsd: 260 })).toBe(10);
    expect(unstakeLabelUsd({ unit: "TAO", raw: "1", fixed: false, requestWei: 10n ** 18n, priceUsd: 260 })).toBeUndefined();
    expect(unstakeLabelUsd({ unit: "USDC", raw: "", fixed: false, requestWei: null, priceUsd: 260 })).toBeUndefined();
  });

  it("states what can be unstaked and the minimum in the unit shown", () => {
    const available = 70_219_000_000_000_000n;
    expect(unstakeNote(available, "USDC", 252)).toBe("You can unstake up to $17.69. The minimum is about $1.26 (0.005 TAO).");
    expect(unstakeNote(available, "TAO", 252)).toBe("You can unstake up to 0.070219 TAO. The minimum is 0.005 TAO.");
  });

  it("rounds the dollar minimum up, so typing the minimum shown is always accepted", () => {
    expect(unstakeNote(70_219_000_000_000_000n, "USDC", 252.4)).toMatch(/minimum is about \$1\.27 /);
  });

  it("explains a refused amount in dollars when typing dollars", () => {
    const available = 70_219_000_000_000_000n;
    expect(unstakeErrorText({ ok: false, code: "belowMin", reason: "Unstake at least 0.005 TAO", offerAll: false }, available, "USDC", 252)).toBe(
      "The minimum unstake is about $1.26 (0.005 TAO).",
    );
    expect(unstakeErrorText({ ok: false, code: "tooMuch", reason: "x", offerAll: true }, available, "USDC", 252)).toBe(
      "That's more than you can unstake (up to $17.69).",
    );
    expect(unstakeErrorText({ ok: false, code: "leavesDust", reason: "x", offerAll: true }, available, "USDC", 252)).toBe(
      "That would leave less than about $1.26 staked, too little to unstake later.",
    );
    expect(unstakeErrorText({ ok: false, code: "belowMin", reason: "Unstake at least 0.005 TAO", offerAll: false }, available, "TAO", 252)).toBe(
      "Unstake at least 0.005 TAO",
    );
  });

  it("keeps the exact TAO when switching units, so switching never changes what is sent", () => {
    expect(switchUnstakeUnit(5_000_000_000_000_000n, "TAO", 252.4)).toEqual({ unit: "USDC", raw: "1.26", pinned: 5_000_000_000_000_000n });
    expect(switchUnstakeUnit(5_000_000_000_000_000n, "USDC", 252.4)).toEqual({ unit: "TAO", raw: "0.005", pinned: 5_000_000_000_000_000n });
    expect(switchUnstakeUnit(null, "TAO", 252.4)).toEqual({ unit: "USDC", raw: "", pinned: null });
  });

  it("turns a USDC amount into TAO at the current price, floored to whole rao", () => {
    expect(unstakeRequestWei("10", "USDC", 252.4)).toBe(39_619_651_000_000_000n);
    expect(unstakeRequestWei("0.005", "TAO", 252.4)).toBe(5_000_000_000_000_000n);
    expect(unstakeRequestWei("", "USDC", 252.4)).toBeNull();
    expect(unstakeRequestWei("0", "TAO", 252.4)).toBeNull();
    expect(unstakeRequestWei("10", "USDC", 0)).toBeNull();
  });

  it("shows the other unit beside what was typed", () => {
    expect(unstakeEquivalent(5_000_000_000_000_000n, "TAO", 252.4)).toBe("≈ $1.26");
    expect(unstakeEquivalent(39_619_651_000_000_000n, "USDC", 252.4)).toBe("≈ 0.0396 TAO");
  });

  it("fills MAX in the unit shown: dollars floored to cents", () => {
    expect(maxUnstakeInputIn(90_086_006_000_000_000n, "USDC", 252.4)).toBe("22.73");
    expect(maxUnstakeInputIn(90_086_006_000_000_000n, "TAO", 252.4)).toBe("0.090086");
  });

  it("shows payouts to the cent", () => {
    expect(formatUsdcCents(0.9935)).toBe("0.99");
    expect(formatUsdcCents(1)).toBe("1.00");
    expect(formatUsdcCents(1234.5)).toBe("1,234.50");
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
