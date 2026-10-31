import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { STALE_MS } from "./batch-clock";
import type { CloseOp, Operation } from "./cascade/oplog";
import type { OpenBatch } from "./cascade/types";
import { closeSentFromHere, feeToPay, sendNowValue, sendNowView } from "./send-now";

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ME = "0x000000000000000000000000000000000000a11c" as const;
/** 8:00 AM UTC (the tests read times in UTC). */
const START = 1_800_000_000;
const DAY_S = 86_400;
/** When the read landed, by this device's clock (ms): a clock with no relation to Base's. */
const READ = 1_000_000_000_000;
/** Today's bridge fee for a one-entry batch, as the adapter quoted it on Base (0.000745 ETH). */
const FEE = 744_898_037_875_672n;

/** The open batch as read two hours in (10:00 AM on Base's clock): it can close, and the account has a deposit in it. */
const batch = (over: Partial<OpenBatch> = {}): OpenBatch => ({
  id: 7n,
  start: START,
  interval: 3_600,
  canClose: true,
  paused: false,
  chainTime: START + 7_200,
  mine: { depositWei: 10n ** 17n, redeemShares: 0n },
  potWei: 0n,
  feeWei: FEE,
  ethWei: 10n ** 16n,
  gasWei: 10n ** 13n,
  ethPriceUsd: 2_330,
  ...over,
});

/** The view for a launch deployment (24-hour max wait), `after` ms since the read landed. */
const view = (over: Partial<OpenBatch> = {}, x: { after?: number; maxWaitS?: number; sending?: { hash: Hex } } = {}) =>
  sendNowView({
    batch: batch(over),
    maxWaitS: "maxWaitS" in x ? x.maxWaitS : DAY_S,
    readAt: READ,
    now: READ + (x.after ?? 0),
    ...(x.sending ? { sending: x.sending } : {}),
  });
const button = (over: Partial<OpenBatch> = {}) => view(over)?.button;

const LEAVES = "Leaves in 22 h (by 8:00 AM tomorrow), or sooner if more deposits share the bridge fee.";

describe("what the user pays toward the bridge fee", () => {
  it("is the fee less what the batch's unstake fees (its pot) already hold", () => {
    expect(feeToPay(FEE, 0n)).toBe(FEE);
    expect(feeToPay(10n ** 15n, 10n ** 14n)).toBe(9n * 10n ** 14n);
  });

  it("is nothing once the pot covers the fee", () => {
    expect(feeToPay(10n ** 15n, 10n ** 15n)).toBe(0n);
    expect(feeToPay(10n ** 15n, 3n * 10n ** 15n)).toBe(0n);
  });
});

describe("what closeBatch is sent with", () => {
  it("is the fee plus 30%, rounded up to 0.000001 ETH, when the pot is empty", () => {
    // 0.000744898… × 1.3 = 0.000968367… → 0.000969 ETH
    expect(sendNowValue(FEE, 0n)).toBe(969_000_000_000_000n);
    expect(sendNowValue(10n ** 15n, 0n)).toBe(13n * 10n ** 14n);
  });

  it("leaves 30% over the whole fee once the pot is added: the fee moves as a whole, not only the part the user pays", () => {
    // fee 0.001, pot 0.0004: the user pays 0.0006, and sends 0.0013 − 0.0004 = 0.0009
    expect(sendNowValue(10n ** 15n, 4n * 10n ** 14n)).toBe(9n * 10n ** 14n);
    // a pot that covers the fee but not the margin: only the margin is sent
    expect(sendNowValue(10n ** 15n, 11n * 10n ** 14n)).toBe(2n * 10n ** 14n);
    // a pot that covers the fee and the margin: nothing is sent
    expect(sendNowValue(10n ** 15n, 13n * 10n ** 14n)).toBe(0n);
    expect(sendNowValue(10n ** 15n, 3n * 10n ** 15n)).toBe(0n);
  });

  it("always gives the front door at least the fee plus 30%, never more than 0.000001 ETH over it", () => {
    for (const fee of [1n, 999_999n, FEE, 10n ** 15n + 7n, 3n * 10n ** 15n + 123_456_789n]) {
      for (const pot of [0n, 1n, fee / 3n, fee, fee + 1n, (fee * 13n) / 10n, 2n * fee]) {
        const value = sendNowValue(fee, pot);
        const want = (fee * 130n + 99n) / 100n;
        expect(value % 10n ** 12n, `${fee} ${pot}`).toBe(0n);
        expect(pot + value, `${fee} ${pot}`).toBeGreaterThanOrEqual(want);
        if (value > 0n) expect(pot + value - want, `${fee} ${pot}`).toBeLessThan(10n ** 12n);
      }
    }
  });
});

describe("Send it now, before the batch can close", () => {
  it("counts down to when it leaves on its own and to when the user can send it, on Base's clock", () => {
    // read ten minutes in
    expect(view({ canClose: false, chainTime: START + 600 })).toEqual({
      leaves: "Leaves in 23 h 50 min (by 8:00 AM tomorrow), or sooner if more deposits share the bridge fee.",
      yourself: "Send it yourself in 50 min (from 9:00 AM).",
    });
    // two minutes later by this device's clock, before the next read
    expect(view({ canClose: false, chainTime: START + 600 }, { after: 120_000 })).toEqual({
      leaves: "Leaves in 23 h 48 min (by 8:00 AM tomorrow), or sooner if more deposits share the bridge fee.",
      yourself: "Send it yourself in 48 min (from 9:00 AM).",
    });
  });

  it("says under a minute, then any moment now while Base hasn't yet said it can close", () => {
    expect(view({ canClose: false, chainTime: START + 3_570 })?.yourself).toBe("Send it yourself in under a minute (from 9:00 AM).");
    expect(view({ canClose: false, chainTime: START + 3_620 })?.yourself).toBe("Send it yourself any moment now.");
  });

  it("shows a dash in place of every time once the read is stale", () => {
    expect(view({ canClose: false, chainTime: START + 600 }, { after: STALE_MS + 1_000 })).toEqual({
      leaves: "Leaves in –",
      yourself: "Send it yourself in –",
    });
  });
});

describe("Send it now, once the batch can close", () => {
  it("offers the fee the user pays, in dollars of ETH, and what the wallet sends at most", () => {
    expect(view()).toEqual({
      leaves: LEAVES,
      button: {
        // 0.000744898 ETH at $2,330
        label: "Send it now: about $1.74 in ETH",
        // 0.000969 ETH at $2,330
        note: "You pay the bridge fee for the whole batch. Your wallet sends up to $2.26 in ETH; anything extra is refunded.",
        disabled: false,
      },
    });
  });

  it("takes the batch's unstake fees off what the user pays", () => {
    // fee 0.001, pot 0.0004: about 0.0006 ETH to pay, 0.0009 sent
    const b = button({ feeWei: 10n ** 15n, potWei: 4n * 10n ** 14n, ethPriceUsd: 2_000 });
    expect(b).toMatchObject({ label: "Send it now: about $1.20 in ETH", disabled: false });
    expect(b?.note).toContain("up to $1.80 in ETH");
  });

  it("says so when the pot already covers the fee: nothing to pay but the network fee", () => {
    expect(button({ feeWei: 10n ** 15n, potWei: 2n * 10n ** 15n })).toEqual({
      label: "Send it now: no bridge fee to pay",
      note: "The fees already in this batch cover its bridge fee, so you pay only Base's network fee.",
      disabled: false,
    });
  });

  it("names the margin the wallet sends when the pot covers the fee but not the 30%", () => {
    expect(button({ feeWei: 10n ** 15n, potWei: 11n * 10n ** 14n, ethPriceUsd: 2_000 })).toMatchObject({
      label: "Send it now: no bridge fee to pay",
      note: "The fees already in this batch cover its bridge fee, so you pay only Base's network fee. Your wallet sends up to $0.40 in ETH in case the fee rises; anything extra is refunded.",
    });
  });

  it("asks for the ETH the wallet is short of, the network fee included, and holds the button", () => {
    // 0.000969 sent + 0.00001 for gas = 0.000979 ETH at $2,330
    expect(button({ ethWei: 5n * 10n ** 14n })).toMatchObject({
      label: "Send it now: about $1.74 in ETH",
      warning: "You need about $2.28 of ETH on Base for this.",
      disabled: true,
    });
    // exactly enough is enough
    expect(button({ ethWei: 979_000_000_000_000n })).toMatchObject({ disabled: false });
    expect(button({ ethWei: 979_000_000_000_000n })).not.toHaveProperty("warning");
  });

  it("checks the value alone when the network fee can't be read, and holds nothing when the balance can't be", () => {
    expect(button({ gasWei: undefined, ethWei: 969_000_000_000_000n })).toMatchObject({ disabled: false });
    expect(button({ gasWei: undefined, ethWei: 968_999_999_999_999n })).toMatchObject({ disabled: true });
    expect(button({ ethWei: undefined })).toMatchObject({ disabled: false });
  });

  it("shows ETH when its price can't be read, never a dollar figure it can't stand behind", () => {
    expect(button({ ethPriceUsd: undefined, ethWei: 0n })).toMatchObject({
      label: "Send it now: about 0.000745 ETH",
      note: "You pay the bridge fee for the whole batch. Your wallet sends up to 0.000969 ETH; anything extra is refunded.",
      warning: "You need about 0.000979 ETH on Base for this.",
    });
  });

  it("shows a dash and holds the button when the fee can't be read", () => {
    expect(view({ feeWei: undefined })).toEqual({
      leaves: LEAVES,
      button: { label: "Send it now: about –", note: "We can't read the bridge fee right now, so it can't be sent from here yet.", disabled: true },
    });
  });

  it("shows a dash and holds the button once the read is stale: its fee and its time may both have moved", () => {
    expect(view({}, { after: STALE_MS + 1_000 })).toEqual({
      leaves: "Leaves in –",
      button: { label: "Send it now: about –", note: "We can't read the batch on Base right now, so it can't be sent from here yet.", disabled: true },
    });
  });

  it("says it leaves any moment now past the max wait, and still lets the user send it", () => {
    const v = view({ chainTime: START + DAY_S + 60 });
    expect(v?.leaves).toBe("Leaves any moment now.");
    expect(v?.button?.disabled).toBe(false);
  });

  it("says it leaves any moment now when it's full (it could close before its interval)", () => {
    expect(view({ chainTime: START + 600 })?.leaves).toBe("Leaves any moment now.");
  });
});

describe("Send it now isn't offered", () => {
  it("while Cascade is paused", () => {
    expect(view({ paused: true })).toBeNull();
    expect(view({ paused: true, canClose: false })).toBeNull();
  });

  it("when nothing of the account's is in the open batch (it already left, or was taken back out)", () => {
    expect(view({ mine: { depositWei: 0n, redeemShares: 0n } })).toBeNull();
    expect(view({ mine: { depositWei: 0n, redeemShares: 10n ** 21n } })).not.toBeNull();
  });

  it("without a max wait: the keeper then sends each batch as soon as it can close", () => {
    expect(view({}, { maxWaitS: undefined })).toBeNull();
    expect(view({}, { maxWaitS: 3_600 })).toBeNull();
  });
});

describe("a send from this browser that Base hasn't shown yet", () => {
  const close = (over: Partial<CloseOp> = {}): CloseOp => ({
    id: "c1",
    kind: "close",
    account: ME,
    createdAt: 1_000_000,
    batchId: 7n,
    value: 969_000_000_000_000n,
    hashes: { close: H(5) },
    state: "running",
    ...over,
  });
  const now = 1_000_000 + 60_000;

  it("shows as sending, with its transaction, in place of the button", () => {
    expect(closeSentFromHere([close()], 7n, now)).toEqual({ hash: H(5) });
    expect(view({}, { sending: { hash: H(5) } })).toEqual({
      leaves: LEAVES,
      sending: { text: "Sending your batch to Bittensor…", txUrl: `https://basescan.org/tx/${H(5)}` },
    });
    // its record says sent while the read of the batch is older
    expect(closeSentFromHere([close({ state: "sent" })], 7n, now)).toEqual({ hash: H(5) });
  });

  it("is only one for this batch, with a hash, not failed, and less than ten minutes old", () => {
    const other: Operation = { id: "w1", kind: "withdrawal", account: ME, createdAt: 1_000_000, shares: 1n, taoEstimate: 1n, usdcEstimate: 1n, fee: 0n, hash: H(6), state: "sent" };
    expect(closeSentFromHere([other], 7n, now)).toBeUndefined();
    expect(closeSentFromHere([close({ batchId: 6n })], 7n, now)).toBeUndefined();
    expect(closeSentFromHere([close({ hashes: {} })], 7n, now)).toBeUndefined();
    expect(closeSentFromHere([close({ state: "failed" })], 7n, now)).toBeUndefined();
    expect(closeSentFromHere([close()], 7n, 1_000_000 + 10 * 60_000)).toBeUndefined();
  });
});
