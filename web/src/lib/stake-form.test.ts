import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WithdrawalQuote, WithdrawalRecord } from "./cascade/types";
import {
  breakEvenDays,
  etaText,
  unstakeEtaText,
  breakEvenText,
  cascadeFeesText,
  closeFirstNeeded,
  stakeRoom,
  CLAIM_ENDS_DELIVERY,
  claimEndsDelivery,
  deliveryFloorUsd,
  deliveryNote,
  maxStakeInput,
  stakeMaxInput,
  offerClaim,
  claimChecking,
  stakeAgainHref,
  stakeAmountParam,
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
  ORIGIN_DEPOSIT_NOTE,
  originDepositNote,
  atomicOf,
  stakeFormNote,
  stakeFormReducer,
  stakeHold,
  UNSTAKE_FORM_CLEARED,
  UNSTAKE_WINDOW_NOTE,
  unstakeFormRequest,
  unstakeReceiveText,
  type UnstakeFormState,
  claimButtonLabel,
  claimChoices,
  deliveryLaterText,
  RECEIVE_ENDS_DELIVERY,
  RECEIVE_TAO_LABEL,
  RECEIVE_TAO_NOTE,
  shownUnstakeUnit,
  unstakeActions,
  deliveryOffClaim,
  DELIVERY_IS_OFF,
  TURN_OFF_DELIVERY,
  turnOffDeliveryOffered,
  QUOTE_FAILED,
  unstakeFormError,
} from "./stake-form";
import { CLAIM_TAO_NOW } from "./cascade/flows";
import { type DeliveryLimit, LIMIT_UNREAD, limitText, NO_DELIVERY, RECEIVE_TAO_POINTER, WAITING_UNKNOWN } from "./cascade/delivery-limit";
import { IMPACT_REFUSED } from "./cascade/impact";
import { MIN_UNSTAKE_WEI, MIN_UNSTAKE_WEI_V3 } from "./cascade/config";
import { checkUnstake } from "./cascade/units";
import { depositNotice } from "./sent";
import { formatUsdcCents, parseAmount, sanitizeAmountInput } from "./format";

const limits = { minUsd: 10, maxUsd: 50_000, full: null };

describe("a fresh stake from a receipt (Stake again at today's price)", () => {
  it("links to the stake form with the same amount typed in, to the cent, or without one when it isn't known", () => {
    expect(stakeAgainHref(20)).toBe("/stake?amount=20.00");
    expect(stakeAgainHref(19.999999)).toBe("/stake?amount=20.00");
    expect(stakeAgainHref(1234.5)).toBe("/stake?amount=1234.50");
    expect(stakeAgainHref(undefined)).toBe("/stake");
    expect(stakeAgainHref(0)).toBe("/stake");
  });

  it("types into the form only plain dollars and cents from the link, nothing else", () => {
    expect(stakeAmountParam("20.00")).toBe("20.00");
    expect(stakeAmountParam("20")).toBe("20");
    expect(stakeAmountParam("0.5")).toBe("0.5");
    for (const bad of [null, "", "-20", "20.000", "1e3", "20,00", "$20", " 20", "20 ", "<script>", "1234567890", "Infinity"]) {
      expect(stakeAmountParam(bad), String(bad)).toBe("");
    }
  });
});

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

  it("warns any other contract account that it can only leave through Unstake here, and that its address on Bittensor may be someone else's (R6, ChatGPT R2 claim B)", () => {
    expect(contractWalletNote({ code: "0x6080604052348015600f57600080fd5b50" })).toBe(CONTRACT_WALLET_NOTE);
    // a proxy (like a Safe) is a contract too, even a short one
    expect(contractWalletNote({ code: "0x363d3d373d3d3d363d73" })).toBe(CONTRACT_WALLET_NOTE);
    expect(CONTRACT_WALLET_NOTE).toBe(
      "This wallet is a contract account: it can leave only through Unstake here, and its address on Bittensor may belong to someone else, who could withdraw its stake there. A regular wallet avoids this.",
    );
  });

  it("R6 (ChatGPT R2 claim B): warns before a stake into an address that already withdraws on Bittensor, and says nothing otherwise", () => {
    expect(originDepositNote({ withdrawsOnBittensor: true })).toBe(ORIGIN_DEPOSIT_NOTE);
    expect(ORIGIN_DEPOSIT_NOTE).toBe(
      "This address withdraws on Bittensor, not here, so a new stake could leave only there, by whoever controls the address on Bittensor. Set Base as its withdrawal chain from Bittensor first, or use another wallet.",
    );
    expect(originDepositNote({})).toBeNull();
    expect(originDepositNote(undefined)).toBeNull();
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

describe("R8 (the contracts review's L-1): send the full open batch first, then stake", () => {
  /** $5 to $1,000 now, the open batch left with room for $1,000; $2,400 once it has left */
  const lim = { minUsd: 5, maxUsd: 1_000, full: null, afterClose: { maxTao: 10n * 10n ** 18n, maxUsd: 2_400 } } as const;

  it("closeFirstNeeded: a stake the open batch can't take that fits once it has left; never for a full cap, one that fits now, or past the next batch's room", () => {
    expect(closeFirstNeeded(1_500, lim)).toBe(true);
    expect(closeFirstNeeded(2_400, lim)).toBe(true);
    // fits the open batch: an ordinary stake
    expect(closeFirstNeeded(1_000, lim)).toBe(false);
    // more than the next batch takes, under the minimum, nothing typed: the form's own words
    expect(closeFirstNeeded(2_400.01, lim)).toBe(false);
    expect(closeFirstNeeded(4, lim)).toBe(false);
    expect(closeFirstNeeded(null, lim)).toBe(false);
    // a full batch: any stake the next one takes
    expect(closeFirstNeeded(20, { ...lim, full: "batch" })).toBe(true);
    // the cap is full: a close frees none of it
    expect(closeFirstNeeded(20, { ...lim, full: "cap" })).toBe(false);
    // no batch to close (it can't close now, or the cap binds, or v3-launch): never
    expect(closeFirstNeeded(1_500, { minUsd: 5, maxUsd: 1_000, full: null })).toBe(false);
    expect(closeFirstNeeded(1_500, undefined)).toBe(false);
    // more than the wallet holds
    expect(closeFirstNeeded(1_500, lim, 1_499)).toBe(false);
    expect(closeFirstNeeded(1_500, lim, 1_500)).toBe(true);
  });

  it("R9 (L-1): stakeRoom, the room read again at the click, by the form's own rules: the open batch takes it now, it fits only once the batch has left, or neither", () => {
    expect(stakeRoom(1_000, lim)).toBe("now");
    expect(stakeRoom(1_500, lim)).toBe("after-close");
    expect(stakeRoom(20, { ...lim, full: "batch" })).toBe("after-close");
    // the cap filled, more than the next batch takes, or the batch can no longer close: neither
    expect(stakeRoom(20, { ...lim, full: "cap" })).toBe("none");
    expect(stakeRoom(2_400.01, lim)).toBe("none");
    expect(stakeRoom(1_500, { minUsd: 5, maxUsd: 1_000, full: null })).toBe("none");
    // under the minimum: never "now"
    expect(stakeRoom(4, lim)).toBe("none");
  });

  it("the button says it sends the batch first; MAX on a full batch types the most the next batch takes", () => {
    expect(stakeButtonLabel({ account: "0xa", amount: 20, error: null, pending: false, dollars: true, closeFirst: true })).toBe("Send the batch, then stake $20");
    expect(stakeButtonLabel({ account: "0xa", amount: 500, error: null, pending: false, closeFirst: true })).toBe("Send the batch, then stake 500 USDC");
    expect(stakeButtonLabel({ account: "0xa", amount: 20, error: null, pending: true, closeFirst: true })).toBe("Confirm in your wallet…");
    expect(stakeMaxInput(5_000, { ...lim, full: "batch" })).toBe("2400.00");
    expect(stakeMaxInput(100, { ...lim, full: "batch" })).toBe("100.00");
    // a batch with room keeps MAX at what fits now; a full cap types the balance, and the form says why
    expect(stakeMaxInput(5_000, lim)).toBe("1000.00");
    expect(stakeMaxInput(5_000, { ...lim, full: "cap" })).toBe("5000.00");
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
    expect(unstakeNote(available, "USDC", 252, undefined, MIN_UNSTAKE_WEI_V3)).toBe("You can unstake up to $17.69. The minimum is about $2.78 (0.011 TAO).");
    expect(unstakeNote(available, "TAO", 252, undefined, MIN_UNSTAKE_WEI_V3)).toBe("You can unstake up to 0.070219 TAO. The minimum is 0.011 TAO.");
  });

  it("MAX fills no more than one unstake can carry, and leaves at least the minimum behind", () => {
    const TAO = 10n ** 18n;
    const most = (99n * TAO) / 10n;
    expect(unstakeMaxWei(25n * TAO, most, MIN_UNSTAKE_WEI_V3)).toBe(most);
    expect(unstakeMaxWei(5n * TAO, most, MIN_UNSTAKE_WEI_V3)).toBe(5n * TAO);
    // 0.005 TAO over the most: MAX leaves the 0.011 TAO minimum, so what stays can be unstaked later
    expect(unstakeMaxWei(most + 5n * 10n ** 15n, most, MIN_UNSTAKE_WEI_V3)).toBe(most + 5n * 10n ** 15n - 11n * 10n ** 15n);
    // no limit known (v2): the whole stake, as before
    expect(unstakeMaxWei(25n * TAO, undefined, MIN_UNSTAKE_WEI_V3)).toBe(25n * TAO);
  });

  it("MAX fills nothing, never zero or less, when no amount can go: the open request already at the cap, or nothing to unstake", () => {
    const TAO = 10n ** 18n;
    // the open batch's request already carries 9.89 TAO of the 9.9: room for 0.01, under the 0.011 minimum
    expect(unstakeMaxWei(25n * TAO, 10n ** 16n, MIN_UNSTAKE_WEI_V3)).toBeNull();
    expect(unstakeMaxWei(25n * TAO, 0n, MIN_UNSTAKE_WEI_V3)).toBeNull();
    // room of 0.012 TAO, but taking it would leave less than the minimum behind and all of it is too much
    expect(unstakeMaxWei(20n * 10n ** 15n, 12n * 10n ** 15n, MIN_UNSTAKE_WEI_V3)).toBeNull();
    expect(unstakeMaxWei(0n, undefined, MIN_UNSTAKE_WEI_V3)).toBeNull();
    expect(unstakeMaxWei(0n, 9n * TAO, MIN_UNSTAKE_WEI_V3)).toBeNull();
  });

  it("says the batch's request is already full instead of an amount of 0 TAO", () => {
    const TAO = 10n ** 18n;
    const full = "Your unstake in the current batch is already as large as one can be; unstake more after it leaves.";
    expect(unstakeNote(25n * TAO, "TAO", 250, 10n ** 16n, MIN_UNSTAKE_WEI_V3)).toBe(full);
    expect(unstakeNote(25n * TAO, "USDC", 250, 0n, MIN_UNSTAKE_WEI_V3)).toBe(full);
  });

  it("says why the amount is capped, in the unit shown", () => {
    const TAO = 10n ** 18n;
    const most = (99n * TAO) / 10n;
    expect(unstakeNote(25n * TAO, "TAO", 250, most, MIN_UNSTAKE_WEI_V3)).toBe("One unstake can carry up to 9.9 TAO; unstake the rest a day later (unstakes are limited per day). The minimum is 0.011 TAO.");
    expect(unstakeNote(25n * TAO, "USDC", 250, most, MIN_UNSTAKE_WEI_V3)).toBe(
      "One unstake can carry up to $2,475.00 (9.9 TAO); unstake the rest a day later (unstakes are limited per day). The minimum is about $2.75 (0.011 TAO).",
    );
    // a stake within the most reads as before
    expect(unstakeNote(70_219_000_000_000_000n, "TAO", 252, most, MIN_UNSTAKE_WEI_V3)).toBe("You can unstake up to 0.070219 TAO. The minimum is 0.011 TAO.");
    const over = { ok: false as const, code: "overEntry" as const, reason: "One unstake can carry up to 9.9 TAO; unstake the rest a day later (unstakes are limited per day)", offerAll: false };
    expect(unstakeErrorText(over, 25n * TAO, "USDC", 250, most, MIN_UNSTAKE_WEI_V3)).toBe("One unstake can carry up to $2,475.00 (9.9 TAO); unstake the rest a day later (unstakes are limited per day).");
    expect(unstakeErrorText(over, 25n * TAO, "TAO", 250, most, MIN_UNSTAKE_WEI_V3)).toBe(over.reason);
  });

  it("on v3.2 states, explains and keeps to its own 0.033 TAO minimum, and the daily limit (the window)", () => {
    const TAO = 10n ** 18n;
    const min = MIN_UNSTAKE_WEI;
    const available = 70_219_000_000_000_000n;
    // 0.033 TAO at $252 is $8.316, rounded up to the cent
    expect(unstakeNote(available, "USDC", 252, undefined, min)).toBe("You can unstake up to $17.69. The minimum is about $8.32 (0.033 TAO).");
    expect(unstakeNote(available, "TAO", 252, undefined, min)).toBe("You can unstake up to 0.070219 TAO. The minimum is 0.033 TAO.");
    expect(unstakeErrorText({ ok: false, code: "belowMin", reason: "Unstake at least 0.033 TAO", offerAll: false }, available, "USDC", 252, undefined, min)).toBe(
      "The minimum unstake is about $8.32 (0.033 TAO).",
    );
    expect(unstakeErrorText({ ok: false, code: "leavesDust", reason: "x", offerAll: true }, available, "USDC", 252, undefined, min)).toBe(
      "That would leave less than about $8.32 staked, too little to unstake later.",
    );
    // MAX over the most leaves v3.2's minimum behind, not v3-launch's
    const most = (99n * TAO) / 10n;
    expect(unstakeMaxWei(most + 5n * 10n ** 15n, most, min)).toBe(most + 5n * 10n ** 15n - min);
    // the form's line on the window: one daily allowance, shared, the rest staked until asked for again
    expect(UNSTAKE_WINDOW_NOTE).toBe("Unstakes share a daily limit; any part over it stays staked, and you unstake it again a day later.");
  });

  it("on v3.2 says the quote is less the unstake's share of any fee the chain charges for its exit (the leaver pays)", () => {
    expect(unstakeReceiveText(19.324, true)).toBe("about 19.32 USDC, less its share of any unstake fee the chain charges (none today)");
    // v3-launch's quote reads as it did
    expect(unstakeReceiveText(19.324, false)).toBe("about 19.32 USDC");
  });

  it("rounds the dollar minimum up, so typing the minimum shown is always accepted", () => {
    // 0.011 TAO at $252.40 is $2.7764
    expect(unstakeNote(70_219_000_000_000_000n, "USDC", 252.4, undefined, MIN_UNSTAKE_WEI_V3)).toMatch(/minimum is about \$2\.78 /);
  });

  it("explains a refused amount in dollars when typing dollars", () => {
    const available = 70_219_000_000_000_000n;
    expect(unstakeErrorText({ ok: false, code: "belowMin", reason: "Unstake at least 0.011 TAO", offerAll: false }, available, "USDC", 252, undefined, MIN_UNSTAKE_WEI_V3)).toBe(
      "The minimum unstake is about $2.78 (0.011 TAO).",
    );
    expect(unstakeErrorText({ ok: false, code: "tooMuch", reason: "x", offerAll: true }, available, "USDC", 252, undefined, MIN_UNSTAKE_WEI_V3)).toBe(
      "That's more than you can unstake (up to $17.69).",
    );
    expect(unstakeErrorText({ ok: false, code: "leavesDust", reason: "x", offerAll: true }, available, "USDC", 252, undefined, MIN_UNSTAKE_WEI_V3)).toBe(
      "That would leave less than about $2.78 staked, too little to unstake later.",
    );
    expect(unstakeErrorText({ ok: false, code: "stakeBelowMin", reason: "x", offerAll: false }, available, "USDC", 252, undefined, MIN_UNSTAKE_WEI_V3)).toBe(
      "Your stake is below the minimum unstake of about $2.78 (0.011 TAO).",
    );
    expect(unstakeErrorText({ ok: false, code: "belowMin", reason: "Unstake at least 0.011 TAO", offerAll: false }, available, "TAO", 252, undefined, MIN_UNSTAKE_WEI_V3)).toBe(
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

describe("the stake form after a stake goes through", () => {
  // before: 80 USDC and room for 60 in the batch; the refresh after a 50 USDC stake: 30 left, room for 10
  const before = { minUsd: 1, maxUsd: 60, full: null };
  const after = { minUsd: 1, maxUsd: 10, full: null };
  const typed = stakeFormReducer({ raw: "", sent: null }, { type: "edit", raw: "50" });
  const notice = depositNotice("d1", { amountUsd: 50, estTao: 0.19, batchIntervalS: 3_600 });

  it("takes the amount before the stake", () => {
    expect(stakeFormNote(parseAmount(typed.raw), { data: before, isError: false }, 80)).toEqual({ error: null, note: "From $1 to $60" });
  });

  it("left in place, the amount just staked reads as too much once the balance and limits refresh (the red flash)", () => {
    expect(stakeFormNote(parseAmount(typed.raw), { data: after, isError: false }, 30).error).toBe("The most you can stake right now is $10.");
    expect(stakeFormNote(parseAmount(typed.raw), { data: before, isError: false }, 30).error).toBe("You have 30 USDC on Base.");
  });

  it("is cleared the moment it goes through, so the refreshed figures show no error", () => {
    const sent = stakeFormReducer(typed, { type: "sent", notice });
    expect(sent.raw).toBe("");
    expect(stakeFormNote(parseAmount(sent.raw), { data: after, isError: false }, 30)).toEqual({ error: null, note: "From $1 to $10" });
    expect(stakeFormNote(parseAmount(sent.raw), { data: before, isError: false }, 0).error).toBeNull();
  });

  it("opens the panel confirming it, which closes leaving the form empty for the next stake", () => {
    const sent = stakeFormReducer(typed, { type: "sent", notice });
    expect(sent.sent).toEqual(notice);
    expect(stakeFormReducer(sent, { type: "dismiss" })).toEqual({ raw: "", sent: null });
    // typing while it was open (it can't be: the page behind a modal is inert) would keep the panel's notice
    expect(stakeFormReducer(sent, { type: "edit", raw: "5" })).toEqual({ raw: "5", sent: notice });
  });

  it("says why there is no range while the limits load or can't be read", () => {
    expect(stakeFormNote(null, { isError: false }, null)).toEqual({ error: null, note: "Checking the limits…" });
    expect(stakeFormNote(50, { isError: true }, 80)).toEqual({ error: null, note: "Limits unavailable right now" });
  });
});

describe("the unstake form after an unstake goes through", () => {
  const price = 250;
  // 0.2 TAO could be unstaked; $20 (0.08 TAO) is asked; the refresh then counts it as asked: 0.12 left
  const typed: UnstakeFormState = { raw: "20", all: false, pinned: null };
  const refreshed = 12n * 10n ** 16n;

  it("asks for what is typed, everything after MAX, or a unit switch's exact TAO", () => {
    expect(unstakeFormRequest(typed, "USDC", 2n * 10n ** 17n, price)).toBe(8n * 10n ** 16n);
    expect(unstakeFormRequest({ ...typed, all: true }, "USDC", 2n * 10n ** 17n, price)).toBe(2n * 10n ** 17n);
    expect(unstakeFormRequest({ ...typed, pinned: 5n * 10n ** 16n }, "USDC", 2n * 10n ** 17n, price)).toBe(5n * 10n ** 16n);
  });

  it("left in place, the amount just asked for reads as wrong once what can be unstaked refreshes (the red flash)", () => {
    // $40 typed, 0.12 TAO ($30) left: more than can be unstaked
    expect(checkUnstake(unstakeFormRequest({ ...typed, raw: "40" }, "USDC", refreshed, price) as bigint, refreshed, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "tooMuch" });
    // MAX after unstaking everything: nothing is left, which reads as an amount still to enter
    expect(checkUnstake(unstakeFormRequest({ ...typed, all: true }, "USDC", 0n, price) as bigint, 0n, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "empty" });
  });

  it("is cleared the moment it goes through, so nothing is checked against the refreshed figures", () => {
    expect(UNSTAKE_FORM_CLEARED).toEqual({ raw: "", all: false, pinned: null });
    expect(unstakeFormRequest(UNSTAKE_FORM_CLEARED, "USDC", refreshed, price)).toBeNull();
    expect(unstakeFormRequest(UNSTAKE_FORM_CLEARED, "TAO", 0n, price)).toBeNull();
  });
});

describe("the claim banner while an unstake that may be delivering is still being checked (review 2)", () => {
  const waiting = 10n ** 16n;
  const checkingUnstake = (over: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
    id: "w9",
    createdAt: new Date(0),
    status: "in_progress",
    steps: [
      { key: "request", title: "Request your unstake", status: "done" },
      { key: "unstake", title: "Unstake on Bittensor", status: "done" },
      { key: "return", title: "Return to Base", status: "checking" },
      { key: "claim", title: "USDC to your wallet", status: "pending" },
    ],
    shares: 1n,
    taoAmount: 0.08,
    claimable: waiting,
    awaitingDelivery: true,
    ...over,
  });

  it("suggests no claim by hand, and keeps claiming as TAO within reach", () => {
    expect(offerClaim(waiting, true, [checkingUnstake()])).toBe(false);
    expect(claimChecking(waiting, true, [checkingUnstake()])).toBe(true);
  });

  it("offers the claim as before once the step is known, or when no automatic delivery is ahead of it", () => {
    const known = checkingUnstake({ steps: checkingUnstake().steps.map((s) => (s.key === "return" ? { ...s, status: "active" as const } : s)) });
    expect(offerClaim(waiting, true, [known])).toBe(true);
    expect(claimChecking(waiting, true, [known])).toBe(false);
    expect(offerClaim(waiting, true, [checkingUnstake({ awaitingDelivery: undefined })])).toBe(true);
    expect(claimChecking(waiting, true, [checkingUnstake({ awaitingDelivery: undefined })])).toBe(false);
  });

  it("leaves v2, an empty balance, unloaded unstakes, and an unstake that offers the claim as they were", () => {
    expect(offerClaim(waiting, false, [checkingUnstake()])).toBe(true);
    expect(claimChecking(waiting, false, [checkingUnstake()])).toBe(false);
    expect(claimChecking(0n, true, [checkingUnstake()])).toBe(false);
    expect(claimChecking(waiting, true, undefined)).toBe(false);
    const ready: WithdrawalRecord = { ...checkingUnstake({ id: "w1", status: "ready", awaitingDelivery: undefined }) };
    expect(offerClaim(waiting, true, [ready, checkingUnstake()])).toBe(true);
    expect(claimChecking(waiting, true, [ready, checkingUnstake()])).toBe(false);
  });
});

describe("v3.2: the stake form while stake is missing (Task 59 review, Minor 2)", () => {
  it("is held with the stake-missing sentence, so the site never sends a stake beside its own paused notice", () => {
    expect(stakeHold({ stakeMissing: true })).toBe(
      "Staking and unstaking are paused for a short while: Cascade is reconnecting to its validator after a change on Bittensor. Nothing has been lost.",
    );
    // not missing, not read yet, or v3-launch (whose proof never says so): the form as before
    expect(stakeHold({})).toBeNull();
    expect(stakeHold(undefined)).toBeNull();
  });
});

// ---- v3.2's unstake form (Task 59a): USDC within the live delivery limit and the impact cap; Receive TAO always open ----

describe("v3.2's unstake form: what each way out offers right now", () => {
  const TAO = 10n ** 18n;
  /** A USDC quote for `tao` TAO (0.001 TAO of bridge fee), its sale's rate `rate` of the probe's (in 1e6ths). */
  const quote = (tao: bigint, rate = 1_000_000n): WithdrawalQuote =>
    ({
      shares: tao * 10n ** 6n,
      taoWei: tao,
      bridgeFeeWei: 10n ** 15n,
      minUsdcPerTao: 243_000_000n,
      deliveryDeadline: 1_800_000_000,
      impact: { tradeIn: 1_000_000n, tradeOut: rate, probeIn: 1_000_000n, probeOut: 1_000_000n },
    }) as WithdrawalQuote;
  /** Right now 5 TAO clears, paying 1,240 USDC; nothing of the account's waits (every payout of its on its way read), no
   * preference set. */
  const LIMIT: DeliveryLimit = { waitingTaoWei: 0n, waitingComplete: true, preferenceSet: false, saleTaoWei: 5n * TAO, saleUsdc: 1_240_000_000n, clearsAll: false };
  const ready = {
    v32: true,
    account: "0x000000000000000000000000000000000000a11c",
    shares: 10n ** 24n,
    quote: quote(TAO),
    limit: { data: LIMIT, isError: false },
    pending: false,
    lowEth: false,
    hold: null,
    blocked: null,
  };
  const OPEN = { offered: true, enabled: true, endsDelivery: false };

  it("a USDC unstake under the limit passes: its button on, the live figure beside it", () => {
    const a = unstakeActions(ready);
    expect(a.usdc).toBe(true);
    expect(a.warning).toBeNull();
    expect(a.notes).toEqual([{ text: "Right now up to 1,240.00 USDC can be delivered. Above that, receive TAO and claim it on Base.", refused: false }]);
    expect(a.tao).toEqual(OPEN);
  });

  it("one over it is refused, with the reason, and Receive TAO offered and on", () => {
    const a = unstakeActions({ ...ready, quote: quote(6n * TAO) });
    expect(a.usdc).toBe(false);
    expect(a.notes).toEqual([{ text: limitText(LIMIT), refused: true }]);
    expect(a.tao).toEqual(OPEN);
  });

  it("says before the USDC button what else of the account's it sells, every time, the limit binding or not (C1)", () => {
    // a payout on its way from a request made anywhere, or in the same open batch, or on Base: the latest request decides
    // for all
    const waiting = { ...LIMIT, waitingTaoWei: 7n * 10n ** 17n };
    for (const l of [waiting, { ...waiting, saleTaoWei: 40n * TAO, clearsAll: true }]) {
      const a = unstakeActions({ ...ready, limit: { data: l, isError: false } });
      expect(a.warning).toBe("Your 0.7000 TAO from earlier unstakes will be sold for USDC too.");
      expect(a.usdc).toBe(true);
    }
    // every payout of the account's read, and nothing waiting: nothing said
    expect(unstakeActions(ready).warning).toBeNull();
    // v3-launch says nothing new
    expect(unstakeActions({ ...ready, v32: false, limit: { data: waiting, isError: false } }).warning).toBeNull();
  });

  it("while the account's events aren't all read, says a USDC unstake sells any of its TAO on its way, without a figure (fix round 2)", () => {
    expect(WAITING_UNKNOWN).toBe("Any TAO from your earlier unstakes will be sold for USDC too.");
    // the scan of its events not complete, a figure found so far or none: the standing line, the USDC button as the limit says
    for (const waitingTaoWei of [0n, 7n * 10n ** 17n]) {
      const a = unstakeActions({ ...ready, limit: { data: { ...LIMIT, waitingTaoWei, waitingComplete: false }, isError: false } });
      expect(a.warning).toBe(WAITING_UNKNOWN);
      expect(a.usdc).toBe(true);
    }
    // not read yet, or the read failed (USDC then refused as unreadable, Receive TAO on): the same line
    expect(unstakeActions({ ...ready, limit: { isError: false } }).warning).toBe(WAITING_UNKNOWN);
    const unread = unstakeActions({ ...ready, limit: { data: { ...LIMIT, waitingTaoWei: 7n * 10n ** 17n }, isError: true } });
    expect(unread).toMatchObject({ usdc: false, warning: WAITING_UNKNOWN, notes: [{ text: LIMIT_UNREAD, refused: true }] });
    expect(unread.tao.enabled).toBe(true);
    // no wallet: nothing said
    expect(unstakeActions({ ...ready, account: null, limit: { isError: false } }).warning).toBeNull();
  });

  it("shows no limit while everything the account has would clear", () => {
    const a = unstakeActions({ ...ready, limit: { data: { ...LIMIT, saleTaoWei: 9n * TAO, clearsAll: true }, isError: false } });
    expect(a.usdc).toBe(true);
    expect(a.notes).toEqual([]);
  });

  it("no USDC delivery at all right now: refused whatever the amount, before one is typed too", () => {
    const none = { data: { ...LIMIT, saleTaoWei: 0n, saleUsdc: 0n }, isError: false };
    for (const q of [quote(TAO / 10n), undefined]) {
      const a = unstakeActions({ ...ready, quote: q, limit: none });
      expect(a.usdc).toBe(false);
      expect(a.notes).toEqual([{ text: NO_DELIVERY, refused: true }]);
      expect(a.tao).toEqual(OPEN);
    }
  });

  it("the limit (and with it what else is sold) can't be read: USDC refused (fail closed), a failed refetch included; while it loads, the button waits", () => {
    const unread = unstakeActions({ ...ready, limit: { isError: true } });
    expect(unread.usdc).toBe(false);
    expect(unread.notes).toEqual([{ text: LIMIT_UNREAD, refused: true }]);
    expect(unread.tao.enabled).toBe(true);
    // the last good reading is no answer now (Task 59a review, M4)
    const stale = unstakeActions({ ...ready, limit: { data: LIMIT, isError: true } });
    expect(stale.usdc).toBe(false);
    expect(stale.notes).toEqual([{ text: LIMIT_UNREAD, refused: true }]);
    const loading = unstakeActions({ ...ready, limit: { isError: false } });
    expect(loading.usdc).toBe(false);
    expect(loading.notes).toEqual([]);
    // Receive TAO on, saying it ends USDC delivery until the chain says no preference is set (re-review, N3)
    expect(loading.tao).toEqual({ ...OPEN, endsDelivery: true });
  });

  it("price impact: 0.99% says nothing, 1% warns, 3% is allowed, 3.01% is refused and points to TAO", () => {
    const clears = { data: { ...LIMIT, clearsAll: true }, isError: false };
    const at = (rate: bigint) => unstakeActions({ ...ready, quote: quote(TAO, rate), limit: clears });
    expect(at(990_100n)).toEqual({ usdc: true, warning: null, notes: [], tao: OPEN });
    expect(at(990_000n)).toEqual({ usdc: true, warning: null, notes: [{ text: "This trade moves the price by 1%.", refused: false }], tao: OPEN });
    expect(at(970_000n)).toEqual({ usdc: true, warning: null, notes: [{ text: "This trade moves the price by 3%.", refused: false }], tao: OPEN });
    expect(at(969_900n)).toEqual({ usdc: false, warning: null, notes: [{ text: `${IMPACT_REFUSED} ${RECEIVE_TAO_POINTER}`, refused: true }], tao: OPEN });
  });

  it("Receive TAO is on whatever holds the USDC unstake: the limit, the impact cap, the limit unread, no quote at all", () => {
    // the outside-price veto, and the indexer it reads, are asked only at the click, and only of a USDC unstake
    // (delivery-limit.ts usdcUnstakeChecks): none of them is an input here
    const states = [
      { quote: quote(6n * TAO) },
      { quote: quote(TAO, 900_000n) },
      { limit: { isError: true } },
      { limit: { data: { ...LIMIT, saleTaoWei: 0n }, isError: false } },
      { quote: undefined },
      { quote: undefined, limit: { isError: true } },
    ];
    for (const s of states) {
      const a = unstakeActions({ ...ready, ...s });
      expect(a.tao.enabled, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? String(v) : v))).toBe(true);
    }
  });

  it("Receive TAO waits only for what holds any request: an amount, a flow running, a hold, the contracts' mismatch, ETH for the fee", () => {
    const off = { offered: true, enabled: false, endsDelivery: false };
    expect(unstakeActions({ ...ready, shares: null }).tao).toEqual(off);
    expect(unstakeActions({ ...ready, lowEth: true }).tao).toEqual(off);
    expect(unstakeActions({ ...ready, pending: true }).tao).toEqual(off);
    expect(unstakeActions({ ...ready, hold: "held" }).tao).toEqual(off);
    expect(unstakeActions({ ...ready, blocked: "mismatch" }).tao).toEqual(off);
    // no wallet: nothing to send from
    expect(unstakeActions({ ...ready, account: null }).tao).toEqual({ offered: false, enabled: false, endsDelivery: false });
  });

  it("says Receive TAO also ends USDC delivery whenever the chain says a preference is set, or that can't be read (I1)", () => {
    expect(unstakeActions({ ...ready, limit: { data: { ...LIMIT, preferenceSet: true }, isError: false } }).tao.endsDelivery).toBe(true);
    expect(unstakeActions({ ...ready, limit: { data: { ...LIMIT, preferenceSet: true, clearsAll: true }, isError: false } }).tao.endsDelivery).toBe(true);
    expect(unstakeActions(ready).tao.endsDelivery).toBe(false);
    // unread, or not read yet (unknown taken as set, the safe side: re-review, N3): said, rather than a delivery ended
    // unannounced
    expect(unstakeActions({ ...ready, limit: { isError: true } }).tao.endsDelivery).toBe(true);
    expect(unstakeActions({ ...ready, limit: { isError: false } }).tao.endsDelivery).toBe(true);
    expect(unstakeActions({ ...ready, limit: { data: LIMIT, isError: true } }).tao.endsDelivery).toBe(true);
    // no wallet: nothing to say
    expect(unstakeActions({ ...ready, account: null, limit: { isError: false } }).tao.endsDelivery).toBe(false);
  });

  it("v3-launch's form is as it was: no lines, no Receive TAO, the USDC button by the quote alone", () => {
    const launch = { ...ready, v32: false, limit: { isError: false } };
    expect(unstakeActions(launch)).toEqual({ usdc: true, warning: null, notes: [], tao: { offered: false, enabled: false, endsDelivery: false } });
    expect(unstakeActions({ ...launch, quote: quote(40n * TAO, 500_000n) }).usdc).toBe(true);
    expect(unstakeActions({ ...launch, quote: undefined }).usdc).toBe(false);
    expect(unstakeActions({ ...launch, lowEth: true }).usdc).toBe(false);
    expect(unstakeActions({ ...launch, hold: "held" }).usdc).toBe(false);
  });

  it("says Receive TAO, and the USDC sale's timing, in short plain words", () => {
    expect(RECEIVE_TAO_LABEL).toBe("Receive TAO instead");
    expect(RECEIVE_TAO_NOTE).toBe("Nothing is sold: your TAO comes back to Base for you to claim. A later USDC unstake would sell it too.");
    expect(RECEIVE_ENDS_DELIVERY).toBe("This also turns off automatic USDC delivery for your other unstakes: you'll claim those by hand.");
    expect(deliveryLaterText(26 * 60)).toBe(
      "With USDC, your TAO is back on Base in about 26 hours and sold then, one sale at a time, so a busy day can take longer. If the market doesn't allow a sale, your TAO stays on Base for you to claim any time.",
    );
    expect(deliveryLaterText(undefined)).toBe(
      "With USDC, your TAO is sold once it is back on Base, one sale at a time, so a busy day can take longer. If the market doesn't allow a sale, your TAO stays on Base for you to claim any time.",
    );
  });

  it("is typed in TAO on v3.2 while TAO's price can't be read: Receive TAO needs no price (M6)", () => {
    expect(shownUnstakeUnit("USDC", { v32: true, priceMissing: true })).toBe("TAO");
    expect(shownUnstakeUnit("USDC", { v32: true, priceMissing: false })).toBe("USDC");
    expect(shownUnstakeUnit("TAO", { v32: true, priceMissing: false })).toBe("TAO");
    expect(shownUnstakeUnit("USDC", { v32: false, priceMissing: true })).toBe("USDC");
  });
});

describe("the claim buttons, by what the unstakes asked for (Task 59a review, M12)", () => {
  it("leads with Claim as TAO for an unstake asked as TAO, Claim as USDC beside it", () => {
    expect(claimChoices({ keepsTao: true, saleHeld: false })).toEqual([
      { label: "Claim as TAO", keepTao: true },
      { label: "Claim as USDC", keepTao: false },
    ]);
    // a USDC claim of it the price check held: TAO stays first, the USDC claim beside it
    expect(claimChoices({ keepsTao: true, saleHeld: true, claimFailed: true })[0]).toEqual({ label: "Claim as TAO", keepTao: true });
  });

  it("is as before for everything else (v3-launch's records included): Claim as USDC, and the TAO after a held sale or a failed swap", () => {
    expect(claimChoices({ keepsTao: false, saleHeld: false })).toEqual([{ label: "Claim as USDC", keepTao: false }]);
    expect(claimChoices({ keepsTao: false, saleHeld: true })).toEqual([
      { label: "Claim as USDC", keepTao: false },
      { label: "Claim as TAO instead", keepTao: true },
    ]);
    expect(claimChoices({ keepsTao: false, saleHeld: false, claimFailed: true })).toEqual([
      { label: "Claim as USDC", keepTao: false },
      { label: "Claim now and swap to USDC separately", keepTao: true },
    ]);
    expect(claimChoices({ keepsTao: false, saleHeld: true, claimFailed: true })[1]).toEqual({ label: "Claim as TAO instead", keepTao: true });
  });

  it("says to confirm in the wallet only on the button pressed, while its claim runs (re-review, N2)", () => {
    const [tao, usdc] = claimChoices({ keepsTao: true, saleHeld: false });
    const labels = (x: { busy: string | null; pressed: boolean | null }) => [claimButtonLabel(tao, x), claimButtonLabel(usdc, x)];
    // the second one pressed: it says so, the first keeps its label
    expect(labels({ busy: "claim", pressed: false })).toEqual(["Claim as TAO", "Confirm in your wallet…"]);
    expect(labels({ busy: "claim", pressed: true })).toEqual(["Confirm in your wallet…", "Claim as USDC"]);
    // a claim not pressed here, another flow running, or none: every button its own label
    expect(labels({ busy: "claim", pressed: null })).toEqual(["Claim as TAO", "Claim as USDC"]);
    expect(labels({ busy: "unstake", pressed: true })).toEqual(["Claim as TAO", "Claim as USDC"]);
    expect(labels({ busy: null, pressed: false })).toEqual(["Claim as TAO", "Claim as USDC"]);
  });
});

describe("usdcDeliveryOffHidesTheOptionAndPromptsAClaim: v3.2's forms with USDC delivery off (Task 60)", () => {
  const TAO = 10n ** 18n;
  const ready = {
    v32: true,
    account: "0x000000000000000000000000000000000000a11c",
    shares: 10n ** 24n,
    quote: { shares: 10n ** 24n, taoWei: TAO, fee: 10n ** 14n } as WithdrawalQuote,
    limit: { isError: false },
    pending: false,
    lowEth: false,
    hold: null,
    blocked: null,
    usdcDelivery: false,
    preference: { data: true, isError: false },
  };

  it("the unstake form: no USDC unstake and no USDC line, Receive TAO on, saying it ends the delivery the chain holds", () => {
    expect(unstakeActions(ready)).toEqual({ usdc: false, warning: null, notes: [], tao: { offered: true, enabled: true, endsDelivery: true } });
    // no preference set: nothing to end; unread or loading: said (unknown taken as set, as N3)
    expect(unstakeActions({ ...ready, preference: { data: false, isError: false } }).tao.endsDelivery).toBe(false);
    expect(unstakeActions({ ...ready, preference: { isError: true } }).tao.endsDelivery).toBe(true);
    expect(unstakeActions({ ...ready, preference: { isError: false } }).tao.endsDelivery).toBe(true);
    // nothing USDC holds it: no limit read, no quote, a limit that would refuse
    for (const s of [{ quote: undefined }, { limit: { isError: true } }]) expect(unstakeActions({ ...ready, ...s }).tao.enabled).toBe(true);
    // what holds any request still holds it
    for (const s of [{ shares: null }, { lowEth: true }, { pending: true }, { hold: "held" }, { blocked: "mismatch" }]) expect(unstakeActions({ ...ready, ...s }).tao.enabled).toBe(false);
    // the switch is v3.2's: v3-launch's form is as it was
    expect(unstakeActions({ ...ready, v32: false })).toEqual({ usdc: true, warning: null, notes: [], tao: { offered: false, enabled: false, endsDelivery: false } });
  });

  it("the amount is typed in TAO: nothing is sold, so no dollar figure is asked for", () => {
    expect(shownUnstakeUnit("USDC", { v32: true, priceMissing: false, usdcDelivery: false })).toBe("TAO");
    expect(shownUnstakeUnit("USDC", { v32: true, priceMissing: false, usdcDelivery: true })).toBe("USDC");
  });

  it("the claim buttons: Claim as TAO alone, whatever was asked for or held", () => {
    for (const x of [
      { keepsTao: true, saleHeld: false },
      { keepsTao: false, saleHeld: false },
      { keepsTao: false, saleHeld: true },
      { keepsTao: false, saleHeld: false, claimFailed: true },
    ]) {
      expect(claimChoices({ ...x, usdcDelivery: false })).toEqual([{ label: "Claim as TAO", keepTao: true }]);
      expect(claimChoices({ ...x, usdcDelivery: true })).toEqual(claimChoices(x));
    }
  });

  it("offers to turn off USDC delivery for the account only when it applies: delivery off, and a preference set or unreadable (follow-up)", () => {
    expect(turnOffDeliveryOffered(false, { data: true, isError: false })).toBe(true);
    // a failed read offers it: unknown means offer it
    expect(turnOffDeliveryOffered(false, { isError: true })).toBe(true);
    // none set, or not read yet: not offered (it would appear and vanish for every account without one)
    expect(turnOffDeliveryOffered(false, { data: false, isError: false })).toBe(false);
    expect(turnOffDeliveryOffered(false, { isError: false })).toBe(false);
    // USDC delivery on: never
    expect(turnOffDeliveryOffered(true, { data: true, isError: false })).toBe(false);
    expect(TURN_OFF_DELIVERY).toBe("Turn off USDC delivery for my account");
    expect(DELIVERY_IS_OFF).toBe("USDC delivery is off.");
  });

  it("the TAO-only form's red line is the amount check's alone: a failed USDC quote says nothing above Receive TAO (review, Important 2)", () => {
    const tooSmall = "The minimum unstake is 0.033 TAO.";
    // USDC delivery off: the quote is the USDC sale's, which Receive TAO doesn't need
    expect(unstakeFormError({ checkError: null, quoteFailed: true, taoOnly: true })).toBeNull();
    expect(unstakeFormError({ checkError: tooSmall, quoteFailed: true, taoOnly: true })).toBe(tooSmall);
    expect(unstakeFormError({ checkError: tooSmall, quoteFailed: false, taoOnly: true })).toBe(tooSmall);
    // with it on, and on every other deployment: as before, the check first, then the failed quote
    expect(unstakeFormError({ checkError: null, quoteFailed: true, taoOnly: false })).toBe(QUOTE_FAILED);
    expect(QUOTE_FAILED).toBe("This amount can't be sent back right now");
    expect(unstakeFormError({ checkError: tooSmall, quoteFailed: true, taoOnly: false })).toBe(tooSmall);
    expect(unstakeFormError({ checkError: null, quoteFailed: false, taoOnly: false })).toBeNull();
    // and so the button keeps its amount, never the bare "Unstake" a red line gives it
    const error = unstakeFormError({ checkError: null, quoteFailed: true, taoOnly: true });
    expect(unstakeButtonLabel({ account: "0x1", amount: 0.5, error, pending: false })).toBe("Unstake 0.50 TAO");
    expect(unstakeButtonLabel({ account: "0x1", amount: 0.5, error: QUOTE_FAILED, pending: false })).toBe("Unstake");
  });

  it("the unstake form takes its red line from unstakeFormError, with taoOnly, and says nothing of its own (review, Important 2)", () => {
    const src = readFileSync(fileURLToPath(new URL("../components/app/UnstakeForm.tsx", import.meta.url)), "utf8");
    // the form's own taoOnly: v3.2 with USDC delivery off
    expect(src).toMatch(/const error = unstakeFormError\(\{[^}]*\n\s*taoOnly,\s*\}\);/);
    expect(src).toContain("const taoOnly = v32 && !usdcDelivery;");
    expect(src).toMatch(/quoteFailed: quoteQuery\.isError && shares !== null/);
    expect(src).not.toContain("can't be sent back right now");
  });

  it("the claim banner: whatever waits on Base, delivering or not, with the prompt while the chain holds a preference or can't tell", () => {
    expect(deliveryOffClaim(0n, { data: true, isError: false })).toBeNull();
    expect(deliveryOffClaim(1n, { data: true, isError: false })).toEqual({ prompt: CLAIM_TAO_NOW });
    expect(deliveryOffClaim(1n, { data: false, isError: false })).toEqual({ prompt: null });
    expect(deliveryOffClaim(1n, { isError: true })).toEqual({ prompt: CLAIM_TAO_NOW });
    expect(deliveryOffClaim(1n, { isError: false })).toEqual({ prompt: CLAIM_TAO_NOW });
  });
});
