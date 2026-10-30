import { describe, expect, it } from "vitest";
import type { WithdrawalRecord } from "./cascade/types";
import {
  breakEvenDays,
  etaText,
  unstakeEtaText,
  breakEvenText,
  cascadeFeesText,
  CLAIM_ENDS_DELIVERY,
  claimEndsDelivery,
  deliveryFloorUsd,
  deliveryNote,
  maxStakeInput,
  stakeMaxInput,
  offerClaim,
  stakeAmountText,
  stakeFootText,
  maxUnstakeInput,
  maxUnstakeInputIn,
  stakeButtonLabel,
  stakeLimitsNote,
  switchUnstakeUnit,
  unstakeErrorText,
  unstakeLabelUsd,
  unstakeMaxWei,
  unstakeNote,
  unstakeButtonLabel,
  unstakeEquivalent,
  unstakeRequestWei,
  validateStakeAmount,
  walletTaoNote,
  CONTRACT_WALLET_NOTE,
  contractWalletNote,
  atomicOf,
} from "./stake-form";
import { formatUsdcCents, parseAmount, sanitizeAmountInput } from "./format";

const limits = { minUsd: 10, maxUsd: 50_000, full: null };

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

  it("says why no amount fits when a limit is reached, rather than a maximum under the minimum", () => {
    const batch = { minUsd: 10, maxUsd: 4, full: "batch" as const };
    expect(validateStakeAmount(20, batch)).toBe("The current batch is full. A new one opens once it leaves, so try again soon.");
    expect(validateStakeAmount(5, batch)).toBe("The current batch is full. A new one opens once it leaves, so try again soon.");
    expect(validateStakeAmount(20, { ...batch, full: "cap" })).toBe("Cascade is full for now. Try again later.");
    expect(validateStakeAmount(null, batch)).toBeNull();
  });
});

describe("walletTaoNote", () => {
  const TAO = 10n ** 18n;
  const l = { minTao: 4n * 10n ** 16n, maxTao: 7n * TAO, full: null };

  it("says nothing when the wallet's TAO can be deposited as it is", () => {
    expect(walletTaoNote(TAO, l)).toBeNull();
    expect(walletTaoNote(4n * 10n ** 16n, l)).toBeNull();
    expect(walletTaoNote(7n * TAO, l)).toBeNull();
  });

  it("says why it can't: under the minimum, more than fits right now, or no room at all", () => {
    expect(walletTaoNote(10n ** 16n, l)).toBe("Deposits start at 0.04 TAO.");
    expect(walletTaoNote(12n * TAO, l)).toBe("Deposits take at most 7.00 TAO right now.");
    expect(walletTaoNote(TAO, { ...l, maxTao: 10n ** 16n, full: "batch" })).toBe("The current batch is full. A new one opens once it leaves, so try again soon.");
    expect(walletTaoNote(TAO, { ...l, maxTao: 0n, full: "cap" })).toBe("Cascade is full for now. Try again later.");
  });

  it("never rounds a limit the wrong way at 6 decimals: the most down, the least up", () => {
    // 6.9999999 TAO fits at most: rounding would have said 7.00, which doesn't fit
    expect(walletTaoNote(12n * TAO, { ...l, maxTao: 6_999_999_900_000_000_000n })).toBe("Deposits take at most 6.999999 TAO right now.");
    // a minimum of 0.0400004 TAO: rounding would have said 0.04, which is under it
    expect(walletTaoNote(10n ** 16n, { ...l, minTao: 40_000_400_000_000_000n })).toBe("Deposits start at 0.040001 TAO.");
  });
});

describe("contractWalletNote", () => {
  it("says nothing for a plain account, or while its code isn't known", () => {
    expect(contractWalletNote({ code: "0x" })).toBeNull();
    expect(contractWalletNote({ code: "0x", connectorId: "io.metamask", atomic: "ready" })).toBeNull();
    expect(contractWalletNote({})).toBeNull();
  });

  it("says nothing for an EIP-7702 account (a key account with a delegation), in any case of hex, batching or not", () => {
    expect(contractWalletNote({ code: `0xef0100${"ab".repeat(20)}` })).toBeNull();
    expect(contractWalletNote({ code: `0xEF0100${"AB".repeat(20)}`, atomic: "supported" })).toBeNull();
  });

  it("warns any other contract account that it can only leave through Unstake here", () => {
    expect(contractWalletNote({ code: "0x6080604052348015600f57600080fd5b50" })).toBe(CONTRACT_WALLET_NOTE);
    // a proxy (like a Safe) is a contract too, even a short one
    expect(contractWalletNote({ code: "0x363d3d373d3d3d363d73" })).toBe(CONTRACT_WALLET_NOTE);
    expect(CONTRACT_WALLET_NOTE).toBe(
      "This wallet is a contract account, so it can only leave Cascade through Unstake here, not directly on Bittensor. If Unstake is ever paused, leaving waits until it reopens.",
    );
  });

  it("warns a smart account that has no code yet: a Base Account (deployed on its first transaction), or one that batches atomically", () => {
    // a brand-new Base Account: no code until its first transaction, but a contract account all the same
    expect(contractWalletNote({ code: "0x", connectorId: "baseAccount" })).toBe(CONTRACT_WALLET_NOTE);
    expect(contractWalletNote({ connectorId: "baseAccount" })).toBe(CONTRACT_WALLET_NOTE);
    // a key account can only batch atomically with a delegation (code), so one with no code that does is a smart account
    expect(contractWalletNote({ code: "0x", atomic: "supported" })).toBe(CONTRACT_WALLET_NOTE);
  });
});

describe("atomicOf", () => {
  it("reads whether a wallet runs a batch atomically on Base from its EIP-5792 capabilities, old shape or new", () => {
    expect(atomicOf({ atomic: { status: "supported" } })).toBe("supported");
    expect(atomicOf({ atomic: { status: "ready" } })).toBe("ready");
    expect(atomicOf({ atomicBatch: { supported: true } })).toBe("supported");
    expect(atomicOf({ atomicBatch: { supported: false } })).toBeUndefined();
    expect(atomicOf(undefined)).toBeUndefined();
    expect(atomicOf({})).toBeUndefined();
  });
});

describe("stakeLimitsNote", () => {
  it("gives the range, or why there is none", () => {
    expect(stakeLimitsNote({ minUsd: 10.33, maxUsd: 2_450, full: null })).toBe("From $10.33 to $2,450");
    expect(stakeLimitsNote({ minUsd: 10, maxUsd: 4, full: "batch" })).toBe("The current batch is full. A new one opens once it leaves, so try again soon.");
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
    expect(unstakeNote(available, "USDC", 252)).toBe("You can unstake up to $17.69. The minimum is about $2.78 (0.011 TAO).");
    expect(unstakeNote(available, "TAO", 252)).toBe("You can unstake up to 0.070219 TAO. The minimum is 0.011 TAO.");
  });

  it("MAX fills no more than one unstake can carry, and leaves at least the minimum behind", () => {
    const TAO = 10n ** 18n;
    const most = (99n * TAO) / 10n;
    expect(unstakeMaxWei(25n * TAO, most)).toBe(most);
    expect(unstakeMaxWei(5n * TAO, most)).toBe(5n * TAO);
    // 0.005 TAO over the most: MAX leaves the 0.011 TAO minimum, so what stays can be unstaked later
    expect(unstakeMaxWei(most + 5n * 10n ** 15n, most)).toBe(most + 5n * 10n ** 15n - 11n * 10n ** 15n);
    // no limit known (v2): the whole stake, as before
    expect(unstakeMaxWei(25n * TAO, undefined)).toBe(25n * TAO);
  });

  it("says why the amount is capped, in the unit shown", () => {
    const TAO = 10n ** 18n;
    const most = (99n * TAO) / 10n;
    expect(unstakeNote(25n * TAO, "TAO", 250, most)).toBe("One unstake can carry up to 9.9 TAO; unstake the rest after this one. The minimum is 0.011 TAO.");
    expect(unstakeNote(25n * TAO, "USDC", 250, most)).toBe(
      "One unstake can carry up to $2,475.00 (9.9 TAO); unstake the rest after this one. The minimum is about $2.75 (0.011 TAO).",
    );
    // a stake within the most reads as before
    expect(unstakeNote(70_219_000_000_000_000n, "TAO", 252, most)).toBe("You can unstake up to 0.070219 TAO. The minimum is 0.011 TAO.");
    const over = { ok: false as const, code: "overEntry" as const, reason: "One unstake can carry up to 9.9 TAO; unstake the rest after this one", offerAll: false };
    expect(unstakeErrorText(over, 25n * TAO, "USDC", 250, most)).toBe("One unstake can carry up to $2,475.00 (9.9 TAO); unstake the rest after this one.");
    expect(unstakeErrorText(over, 25n * TAO, "TAO", 250, most)).toBe(over.reason);
  });

  it("rounds the dollar minimum up, so typing the minimum shown is always accepted", () => {
    // 0.011 TAO at $252.40 is $2.7764
    expect(unstakeNote(70_219_000_000_000_000n, "USDC", 252.4)).toMatch(/minimum is about \$2\.78 /);
  });

  it("explains a refused amount in dollars when typing dollars", () => {
    const available = 70_219_000_000_000_000n;
    expect(unstakeErrorText({ ok: false, code: "belowMin", reason: "Unstake at least 0.011 TAO", offerAll: false }, available, "USDC", 252)).toBe(
      "The minimum unstake is about $2.78 (0.011 TAO).",
    );
    expect(unstakeErrorText({ ok: false, code: "tooMuch", reason: "x", offerAll: true }, available, "USDC", 252)).toBe(
      "That's more than you can unstake (up to $17.69).",
    );
    expect(unstakeErrorText({ ok: false, code: "leavesDust", reason: "x", offerAll: true }, available, "USDC", 252)).toBe(
      "That would leave less than about $2.78 staked, too little to unstake later.",
    );
    expect(unstakeErrorText({ ok: false, code: "stakeBelowMin", reason: "x", offerAll: false }, available, "USDC", 252)).toBe(
      "Your stake is below the minimum unstake of about $2.78 (0.011 TAO).",
    );
    expect(unstakeErrorText({ ok: false, code: "belowMin", reason: "Unstake at least 0.011 TAO", offerAll: false }, available, "TAO", 252)).toBe(
      "Unstake at least 0.011 TAO",
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

  it("keeps MAX to the most a stake can be right now", () => {
    expect(maxStakeInput(5_000, 2_485.49)).toBe("2485.49");
    expect(maxStakeInput(100, 2_485.49)).toBe("100.00");
  });

  it("offers MAX only once both the balance and the limits are in, so it never types more than a stake can be", () => {
    const limits = { minUsd: 10, maxUsd: 2_485.49, full: null };
    expect(stakeMaxInput(5_000, limits)).toBe("2485.49");
    expect(stakeMaxInput(100, limits)).toBe("100.00");
    // the limits still loading: no MAX yet (it would offer the whole balance)
    expect(stakeMaxInput(5_000, undefined)).toBeNull();
    expect(stakeMaxInput(null, limits)).toBeNull();
    // no room at all: MAX types the balance, and the form says why it can't be staked
    expect(stakeMaxInput(5_000, { ...limits, full: "cap" })).toBe("5000.00");
  });
});

describe("v3 stake form", () => {
  it("names the stake in dollars", () => {
    expect(stakeButtonLabel({ account: "0xa", amount: 20, error: null, pending: false, dollars: true })).toBe("Stake $20");
    expect(stakeButtonLabel({ account: "0xa", amount: 1234.5, error: null, pending: false, dollars: true })).toBe("Stake $1,234.50");
    expect(stakeButtonLabel({ account: "0xa", amount: 5, error: "too small", pending: false, dollars: true })).toBe("Stake");
  });

  it("states Cascade's fees as the flat fee plus the percentage, read back from the quote", () => {
    expect(cascadeFeesText({ usdcIn: 1_000_000_000n, depositFeeUsdc: 50_000n, swapFeeUsdc: 1_499_925n })).toBe("$0.05 + 0.15%");
    // the swap fee is floored on chain, so odd amounts land a hair under 15 bps
    expect(cascadeFeesText({ usdcIn: 12_345_678n, depositFeeUsdc: 50_000n, swapFeeUsdc: 18_443n })).toBe("$0.05 + 0.15%");
    expect(cascadeFeesText({ usdcIn: 1_000_000_000n, depositFeeUsdc: 250_000n, swapFeeUsdc: 4_998_750n })).toBe("$0.25 + 0.5%");
    expect(cascadeFeesText({ usdcIn: 1_000_000_000n, depositFeeUsdc: 0n, swapFeeUsdc: 1_500_000n })).toBe("0.15%");
    expect(cascadeFeesText({ usdcIn: 1_000_000_000n, depositFeeUsdc: 0n, swapFeeUsdc: 0n })).toBe("None");
  });

  // fees as live.ts quotes them: Cascade's, plus the pools' 0.34985% on the rest
  const q1000 = { usdcIn: 1_000_000_000n, amountUsd: 1000, depositFeeUsdc: 50_000n, swapFeeUsdc: 1_499_925n, feesUsd: 1.549925 + 998.450075 * 0.0034985 };
  const q20 = { usdcIn: 20_000_000n, amountUsd: 20, depositFeeUsdc: 50_000n, swapFeeUsdc: 29_925n, feesUsd: 0.079925 + 19.920075 * 0.0034985 };

  // leaving also costs the 0.0001 ETH request fee at $4,000 an ETH and a 0.00105 TAO bridge fee at $250 a TAO
  const exit = { exitFixedUsd: 0.0001 * 4000 + 0.00105 * 250, rewardCutBps: 1000 };

  it("counts the days of yield, after Cascade's cut, that pay for the way in and the way out", () => {
    // the yield is earned on what was staked, after the fees in:
    // ($0.15 in + 0.5% of $19.85 out + $0.66 request and bridge fees) / ($19.85 x 5.9% x 0.9 / 365) = 315.6
    expect(breakEvenDays(q20, exit, 5.9)).toBe(316);
    // ($5.04 in + 0.5% of $994.96 out + $0.66) / ($994.96 x 5.9% x 0.9 / 365) = 73.8
    expect(breakEvenDays(q1000, exit, 5.9)).toBe(74);
  });

  it("follows the fixed exit fees and the reward cut", () => {
    // without them: ($0.15 + $0.10) / ($19.85 x 5.9% / 365) = 77.6
    expect(breakEvenDays(q20, { exitFixedUsd: 0, rewardCutBps: 0 }, 5.9)).toBe(78);
    // a 20% cut: 0.911367 / ($19.85 x 5.9% x 0.8 / 365) = 355.0
    expect(breakEvenDays(q20, { ...exit, rewardCutBps: 2000 }, 5.9)).toBe(355);
  });

  it("has no break-even without a yield or an amount", () => {
    expect(breakEvenDays(q1000, exit, 0)).toBeNull();
    expect(breakEvenDays({ ...q1000, amountUsd: 0 }, exit, 5.9)).toBeNull();
    expect(breakEvenDays(q1000, { ...exit, rewardCutBps: 10_000 }, 5.9)).toBeNull();
  });

  it("says the break-even in plain words", () => {
    expect(breakEvenText(62)).toBe("Covers its fees in about 62 days at today's yield.");
    expect(breakEvenText(1)).toBe("Covers its fees in about 1 day at today's yield.");
  });

  it("states what will be staked as an estimate with the least it can be (the stake may get up to 0.5% less)", () => {
    const q = { estTao: 0.079_234_5, minTaoOut: 78_838_000_000_000_000n };
    expect(stakeAmountText(q, true)).toBe("about 0.0792 TAO (at least 0.0788 TAO)");
    // the least is never rounded up past what the stake accepts
    expect(stakeAmountText({ ...q, minTaoOut: 78_899_999_000_000_000n }, true)).toBe("about 0.0792 TAO (at least 0.0788 TAO)");
  });

  it("the line under the form says nothing on v3 about how many wallet prompts to expect", () => {
    expect(stakeFootText(true)).toBe("No Bittensor wallet needed.");
    expect(stakeFootText(false)).toBe("Your wallet asks you to confirm each step, or just once with a smart account. No Bittensor wallet needed.");
  });

  it("v2: the exact figure, as before", () => {
    expect(stakeAmountText({ estTao: 0.079_234_5, minTaoOut: 79_234_500_000_000_000n }, false)).toBe("0.0792 TAO");
  });
});

describe("v3 unstake delivery", () => {
  it("is at least the TAO that comes back at the minimum price, floored to the cent", () => {
    // the bridge fee is padded by a quarter in case it is higher at payout: 0.08 - 0.00125 = 0.07875 TAO
    // at $246.00 a TAO is $19.3725
    expect(deliveryFloorUsd({ taoWei: 80_000_000_000_000_000n, bridgeFeeWei: 1_000_000_000_000_000n, minUsdcPerTao: 246_000_000n })).toBe(19.37);
    expect(deliveryFloorUsd({ taoWei: 80_000_000_000_000_000n, bridgeFeeWei: 0n, minUsdcPerTao: 246_000_000n })).toBe(19.68);
    expect(deliveryFloorUsd({ taoWei: 9n, bridgeFeeWei: 8n, minUsdcPerTao: 246_000_000n })).toBe(0);
  });

  it("says USDC arrives on its own, and the floor once it is known", () => {
    expect(deliveryNote(19.43)).toBe(
      "USDC arrives in your wallet automatically, at least $19.43 (today's price less 2%). If the price falls further, you can claim by hand.",
    );
    expect(deliveryNote(null)).toBe("USDC arrives in your wallet automatically.");
  });
});

describe("offerClaim", () => {
  const unstake = (status: WithdrawalRecord["status"], claim: "pending" | "active" | "action" | "done"): WithdrawalRecord => ({
    id: "w1",
    createdAt: new Date(0),
    status,
    steps: [
      { key: "request", title: "Request your unstake", status: "done" },
      { key: "unstake", title: "Unstake on Bittensor", status: "done" },
      { key: "return", title: "Return to Base", status: claim === "pending" ? "active" : "done" },
      {
        key: "claim",
        title: claim === "action" ? "Claim as USDC" : "USDC to your wallet",
        status: claim,
        ...(claim === "active" ? { detail: "USDC is being delivered to your wallet automatically" } : {}),
      },
    ],
    shares: 1n,
    taoAmount: 0.08,
    claimable: 10n ** 16n,
  });
  const waiting = 10n ** 16n;

  it("is hidden when nothing is waiting", () => {
    expect(offerClaim(0n, false, undefined)).toBe(false);
    expect(offerClaim(0n, true, [])).toBe(false);
    expect(offerClaim(0n, true, [unstake("ready", "action")])).toBe(false);
  });

  it("v2: offers it whenever something is waiting", () => {
    expect(offerClaim(waiting, false, undefined)).toBe(true);
    expect(offerClaim(waiting, false, [unstake("in_progress", "active")])).toBe(true);
  });

  it("v3: offers what no unstake explains (a deposit sent back, an unstake made elsewhere)", () => {
    expect(offerClaim(waiting, true, [])).toBe(true);
    expect(offerClaim(waiting, true, [unstake("paid", "done"), unstake("in_progress", "pending")])).toBe(true);
  });

  it("v3: hidden while an unstake's USDC is being delivered automatically, since delivery sells all of it", () => {
    expect(offerClaim(waiting, true, [unstake("in_progress", "active")])).toBe(false);
    expect(offerClaim(waiting, true, [unstake("paid", "done"), unstake("in_progress", "active")])).toBe(false);
  });

  it("v3: back once that unstake offers the claim by hand", () => {
    expect(offerClaim(waiting, true, [unstake("ready", "action")])).toBe(true);
    // delivery taking longer than usual: the trail offers the claim too
    const slow = unstake("ready", "action");
    slow.steps[3] = { ...slow.steps[3], title: "USDC to your wallet", detail: "USDC is being delivered to your wallet automatically. It's taking longer than usual. You can keep waiting, or claim it as USDC now." };
    expect(offerClaim(waiting, true, [slow])).toBe(true);
  });

  it("v3: shown while some other last step is under way (a claim from this browser settling)", () => {
    const settling = unstake("in_progress", "active");
    settling.steps[3] = { key: "claim", title: "Claim as USDC", status: "active" };
    expect(offerClaim(waiting, true, [settling])).toBe(true);
  });

  it("v3: not while the unstakes are still loading", () => {
    expect(offerClaim(waiting, true, undefined)).toBe(false);
  });

  it("v3: offered when the unstakes can't be read, since claiming needs only Base", () => {
    expect(offerClaim(waiting, true, undefined, true)).toBe(true);
    expect(offerClaim(0n, true, undefined, true)).toBe(false);
  });

  it("v3: offered whenever any unstake offers the claim by hand, even beside one still being delivered", () => {
    expect(offerClaim(waiting, true, [unstake("in_progress", "active"), unstake("ready", "action")])).toBe(true);
  });
});

describe("claimEndsDelivery", () => {
  const record = (awaitingDelivery: boolean): WithdrawalRecord => ({
    id: "w",
    createdAt: new Date(0),
    status: awaitingDelivery ? "in_progress" : "ready",
    steps: [],
    shares: 1n,
    taoAmount: 0.08,
    claimable: 0n,
    ...(awaitingDelivery ? { awaitingDelivery: true as const } : {}),
  });

  it("v3: warns when an unstake still on its way would lose its automatic delivery to a claim now", () => {
    expect(claimEndsDelivery(true, [record(false), record(true)])).toBe(true);
    expect(claimEndsDelivery(true, [record(false)])).toBe(false);
    expect(claimEndsDelivery(true, [])).toBe(false);
    // not known yet, or not readable: nothing said
    expect(claimEndsDelivery(true, undefined)).toBe(false);
  });

  it("v2: never, since nothing is delivered automatically", () => {
    expect(claimEndsDelivery(false, [record(true)])).toBe(false);
  });

  it("says it in one plain sentence", () => {
    expect(CLAIM_ENDS_DELIVERY).toBe(
      "Claiming now also turns off automatic delivery for unstakes still on their way: you'll claim those by hand when they arrive.",
    );
  });
});

describe("etaText", () => {
  it("says minutes up to 90, hours up to 36, then days", () => {
    expect(etaText(27)).toBe("about 27 minutes");
    expect(etaText(90)).toBe("about 90 minutes");
    expect(etaText(180)).toBe("about 3 hours");
    expect(etaText(91)).toBe("about 2 hours");
    expect(etaText(1_467)).toBe("about 24 hours");
    expect(etaText(1_440 + 27 + 24 * 60)).toBe("about 2 days");
    expect(etaText(2_160)).toBe("about 36 hours");
    expect(etaText(2_161)).toBe("about 2 days");
    expect(etaText(1_440 * 2)).toBe("about 2 days");
    expect(etaText(1)).toBe("about 1 minute");
  });
});

describe("unstakeEtaText", () => {
  it("keeps hours as the smallest unit and moves to days past 36 hours", () => {
    expect(unstakeEtaText(30)).toBe("about 1 hour");
    expect(unstakeEtaText(150)).toBe("about 3 hours");
    expect(unstakeEtaText(1_500)).toBe("about 25 hours");
    expect(unstakeEtaText(60 * 72)).toBe("about 3 days");
  });
});
