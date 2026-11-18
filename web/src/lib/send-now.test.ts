import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { STALE_MS } from "./batch-clock";
import type { CloseOp, Operation } from "./cascade/oplog";
import type { OpenBatch } from "./cascade/types";
import { CLOSE_FIRST_SEEN_MS, closeEconomicsOf, closeFirstView, closeSentFromHere, feeToPay, SEND_GRACE_S, sendGate, sendNowKeepsWait, sendNowValue, sendNowView } from "./send-now";

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ME = "0x000000000000000000000000000000000000a11c" as const;
/** 8:00 AM UTC (the tests read times in UTC). */
const START = 1_800_000_000;
const DAY_S = 86_400;
/** When the read landed, by this device's clock (ms): a clock with no relation to Base's. */
const READ = 1_000_000_000_000;
/** Today's bridge fee for a one-entry batch, as the adapter quoted it on Base (0.000745 ETH). */
const FEE = 744_898_037_875_672n;
/** One deposit's fees against today's bridge fee: they don't cover it. */
const SHORT = { feesUsdc: 430_000n, bridgeFeeUsdc: 1_380_000n };
const COVERED = { feesUsdc: 1_380_000n, bridgeFeeUsdc: 1_380_000n };

/** The open batch as read two hours in (10:00 AM on Base's clock): it can close, Bittensor can take it,
 * and the account has a deposit in it. */
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
  bittensor: "open",
  ...over,
});
/** Ten minutes in: it can't close yet, and its fees were weighed against its bridge fee. */
const young = (over: Partial<OpenBatch> = {}) => batch({ canClose: false, chainTime: START + 600, economics: SHORT, bittensor: undefined, ...over });

/** The view for a launch deployment (24-hour max wait), `after` ms since the read landed. */
const view = (over: Partial<OpenBatch> = {}, x: { after?: number; maxWaitS?: number; sending?: { hash: Hex }; what?: "deposit" | "unstake" } = {}) =>
  sendNowView({
    batch: batch(over),
    maxWaitS: "maxWaitS" in x ? x.maxWaitS : DAY_S,
    readAt: READ,
    now: READ + (x.after ?? 0),
    what: x.what ?? "deposit",
    ...(x.sending ? { sending: x.sending } : {}),
  });
const button = (over: Partial<OpenBatch> = {}) => view(over)?.button;

const LEAVES = "Leaves in 22 h (by 8:00 AM tomorrow), or sooner.";

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

describe("the keeper's fee rule (ops closeEconomicsOf), ported", () => {
  it("adds the staker's deposit fee and swap fee on its deposits and the pot, against the bridge fee, in USDC units", () => {
    // ops/test/base-logs.test.ts's batch: one staked deposit of 0.4 TAO at $250, 15 bps, a 0.0001 ETH pot,
    // a 0.0006 ETH bridge fee, ETH at $2,300
    expect(
      closeEconomicsOf({
        nStaked: 1,
        depositFeeUsdc: 50_000n,
        stakedTao: 4n * 10n ** 17n,
        taoPriceUsdc: 250_000_000n,
        swapFeeBps: 15,
        feePot: 10n ** 14n,
        ethPriceUsdc: 2_300_000_000n,
        bridgeFeeWei: 6n * 10n ** 14n,
      }),
    ).toEqual({ feesUsdc: 50_000n + 150_000n + 230_000n, bridgeFeeUsdc: 1_380_000n });
  });
});

describe("when Send it now is offered", () => {
  const gate = (over: Partial<OpenBatch>, nowS: number, maxWaitS = DAY_S) => sendGate(batch(over), maxWaitS, nowS);

  it("only from five minutes past the interval: the keeper, a round a minute, has had its turns by then", () => {
    expect(SEND_GRACE_S).toBe(300);
    expect(gate({ canClose: false, economics: SHORT }, START + 600)).toBe("early");
    expect(gate({ economics: SHORT }, START + 3_600 + 299)).toBe("early");
    expect(gate({}, START + 3_600 + 300)).toBe("open");
  });

  it("never when the keeper sends it at no cost to the user: full, or past its max wait", () => {
    // full: it could close before its interval was up
    expect(gate({ chainTime: START + 600 }, START + 600)).toBe("free");
    expect(gate({}, START + DAY_S)).toBe("free");
    expect(gate({}, START + DAY_S + SEND_GRACE_S - 1)).toBe("free");
    // without a max wait, the keeper sends each batch as soon as it can close
    expect(gate({}, START + 3_600, 3_600)).toBe("free");
  });

  it("again once the keeper is overdue: five minutes past its max wait (or its interval, without one), it isn't running", () => {
    expect(gate({}, START + DAY_S + SEND_GRACE_S)).toBe("open");
    expect(gate({}, START + 3_600 + SEND_GRACE_S, 3_600)).toBe("open");
    // Bittensor's side still decides
    expect(gate({ bittensor: "paused" }, START + DAY_S + SEND_GRACE_S)).toBe("blocked");
  });

  it("not while its fees cover the bridge fee (the keeper sends it at the interval), until the keeper has had its turns", () => {
    expect(gate({ canClose: false, chainTime: START + 600, economics: COVERED }, START + 600)).toBe("covered");
    expect(gate({ chainTime: START + 3_700, economics: COVERED }, START + 3_700)).toBe("covered");
    // still open five minutes past the interval: the keeper is holding it after all
    expect(gate({ economics: COVERED }, START + 3_900)).toBe("open");
    // fees that couldn't be weighed don't close it early for the keeper either
    expect(gate({ canClose: false, chainTime: START + 600, economics: null }, START + 600)).toBe("early");
  });

  it("not when Bittensor's side can't take the batch, nor when it couldn't be checked", () => {
    expect(gate({ bittensor: "paused" }, START + 7_200)).toBe("blocked");
    expect(gate({ bittensor: "unchecked" }, START + 7_200)).toBe("unchecked");
    expect(gate({ bittensor: undefined }, START + 7_200)).toBe("unchecked");
    // checked only once it can close
    expect(gate({ canClose: false, chainTime: START + 600, bittensor: undefined, economics: SHORT }, START + 600)).toBe("early");
  });
});

describe("Send it now, before it's offered", () => {
  it("counts down to when the batch leaves on its own and to when the user can send it, on Base's clock", () => {
    expect(view(young())).toEqual({
      leaves: "Leaves in 23 h 50 min (by 8:00 AM tomorrow), or sooner.",
      yourself: "Send it yourself in 55 min (from 9:05 AM).",
    });
    // two minutes later by this device's clock, before the next read
    expect(view(young(), { after: 120_000 })).toEqual({
      leaves: "Leaves in 23 h 48 min (by 8:00 AM tomorrow), or sooner.",
      yourself: "Send it yourself in 53 min (from 9:05 AM).",
    });
  });

  it("keeps counting down past the interval, to five minutes after it", () => {
    expect(view({ chainTime: START + 3_700 })?.yourself).toBe("Send it yourself in 4 min (from 9:05 AM).");
    expect(view({ chainTime: START + 3_870 })?.yourself).toBe("Send it yourself in under a minute (from 9:05 AM).");
    expect(view({ chainTime: START + 3_700 })).not.toHaveProperty("button");
  });

  it("says any moment now while Base hasn't yet said the batch can close", () => {
    expect(view(young({ chainTime: START + 3_920 }))?.yourself).toBe("Send it yourself any moment now.");
  });

  it("says it leaves within the hour when its fees cover the bridge fee, offering nothing", () => {
    expect(view(young({ economics: COVERED }))).toEqual({ leaves: "Leaves within the hour: its fees cover the bridge fee." });
  });

  it("shows a dash in place of every time once the read is stale", () => {
    expect(view(young(), { after: STALE_MS + 1_000 })).toEqual({ leaves: "Leaves in –", yourself: "Send it yourself in –" });
  });
});

describe("Send it now, once it's offered", () => {
  it("offers the fee the user pays, in dollars (paid in ETH, as its note says), and what the wallet sends at most", () => {
    expect(view()).toEqual({
      leaves: LEAVES,
      button: {
        // 0.000744898 ETH at $2,330
        label: "Send it now: about $1.74",
        // 0.000969 ETH at $2,330, to the cent above
        note: "You pay the whole batch's bridge fee, in ETH. Up to $2.26 is sent; any extra is refunded.",
        disabled: false,
      },
    });
  });

  it("takes the batch's unstake fees off what the user pays", () => {
    // fee 0.001, pot 0.0004: about 0.0006 ETH to pay, 0.0009 sent
    const b = button({ feeWei: 10n ** 15n, potWei: 4n * 10n ** 14n, ethPriceUsd: 2_000 });
    expect(b).toMatchObject({ label: "Send it now: about $1.20", disabled: false });
    expect(b?.note).toContain("Up to $1.80 is sent");
  });

  it("says so when the pot already covers the fee: nothing to pay but the network fee", () => {
    expect(button({ feeWei: 10n ** 15n, potWei: 2n * 10n ** 15n })).toEqual({
      label: "Send it now: no bridge fee to pay",
      note: "This batch's fees already cover its bridge fee, so you pay only Base's network fee.",
      disabled: false,
    });
  });

  it("names the margin the wallet sends when the pot covers the fee but not the 30%", () => {
    expect(button({ feeWei: 10n ** 15n, potWei: 11n * 10n ** 14n, ethPriceUsd: 2_000 })).toMatchObject({
      label: "Send it now: no bridge fee to pay",
      // ETH is named with the figure: this note says it nowhere else
      note: "This batch's fees already cover its bridge fee, so you pay only Base's network fee. Up to $0.40 in ETH is sent in case the fee rises; any extra is refunded.",
    });
  });

  it("says under $0.01, never $0.00, for a tiny amount, and rounds what the wallet may send up to the cent", () => {
    // 0.000002 ETH at $2,330 is $0.0047; 0.000003 sent is $0.007
    expect(button({ feeWei: 2n * 10n ** 12n })).toMatchObject({
      label: "Send it now: under $0.01",
      note: "You pay the whole batch's bridge fee, in ETH. Up to $0.01 is sent; any extra is refunded.",
    });
  });

  it("asks for the ETH the wallet is short of, the network fee included, and holds the button", () => {
    // 0.000969 sent + 0.00001 for gas = 0.000979 ETH at $2,330 = $2.281, to the cent above
    expect(button({ ethWei: 5n * 10n ** 14n })).toMatchObject({
      label: "Send it now: about $1.74",
      warning: "You need about $2.29 of ETH on Base for this.",
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

  it("shows ETH when its price can't be read, never a dollar figure it can't stand behind, nor an amount without its unit", () => {
    expect(button({ ethPriceUsd: undefined, ethWei: 0n })).toMatchObject({
      label: "Send it now: about 0.000745 ETH",
      note: "You pay the whole batch's bridge fee, in ETH. Up to 0.000969 ETH is sent; any extra is refunded.",
      warning: "You need about 0.000979 ETH on Base for this.",
    });
    // nor when the batch's fees cover the fee and only the margin is sent
    expect(button({ feeWei: 10n ** 15n, potWei: 11n * 10n ** 14n, ethPriceUsd: undefined })?.note).toBe(
      "This batch's fees already cover its bridge fee, so you pay only Base's network fee. Up to 0.0002 ETH is sent in case the fee rises; any extra is refunded.",
    );
  });

  it("each note says that what is paid or sent is ETH, whether or not there is a dollar price", () => {
    for (const price of [2_000, undefined]) {
      // a fee to pay: its first sentence says so; fees that cover it, a margin sent: said with the margin
      expect(button({ ethPriceUsd: price })?.note, String(price)).toContain("ETH");
      expect(button({ feeWei: 10n ** 15n, potWei: 11n * 10n ** 14n, ethPriceUsd: price })?.note, String(price)).toMatch(/Up to \S+ (in )?ETH is sent in case the fee rises/);
    }
    // nothing sent at all (the pot covers the fee and its margin): no amount, and none named
    expect(button({ feeWei: 10n ** 15n, potWei: 2n * 10n ** 15n })?.note).not.toContain("ETH");
  });

  it("every amount on the button and in its note has its unit: a dollar sign, or ETH", () => {
    const cases: Partial<OpenBatch>[] = [{}, { ethPriceUsd: undefined }, { feeWei: 2n * 10n ** 12n }, { feeWei: 10n ** 15n, potWei: 4n * 10n ** 14n }, { feeWei: 10n ** 15n, potWei: 11n * 10n ** 14n }, { ethPriceUsd: 0 }];
    for (const over of cases) {
      const b = button(over);
      for (const words of [b?.label ?? "", b?.note ?? ""]) {
        // each number in the words is a dollar figure or is followed by ETH
        for (const m of words.matchAll(/\$?\d[\d.,]*\d|\$?\d/g)) {
          const after = words.slice((m.index ?? 0) + m[0].length);
          expect(m[0].startsWith("$") || after.startsWith(" ETH"), `${JSON.stringify(over, (_k, v) => (typeof v === "bigint" ? String(v) : v))}: ${words}`).toBe(true);
        }
      }
    }
  });

  it("offers it again once the keeper is overdue, five minutes past the max wait, saying when it was due", () => {
    expect(view({ chainTime: START + DAY_S + 400 })).toEqual({
      leaves: "It was due to leave by 8:00 AM and hasn't left yet; you can send it yourself.",
      button: {
        label: "Send it now: about $1.74",
        note: "You pay the whole batch's bridge fee, in ETH. Up to $2.26 is sent; any extra is refunded.",
        disabled: false,
      },
    });
  });

  it("shows a dash and holds the button when the fee can't be read", () => {
    expect(view({ feeWei: undefined })).toEqual({
      leaves: LEAVES,
      button: { label: "Send it now: about –", note: "We can't read the bridge fee right now, so it can't be sent from here yet.", disabled: true },
    });
  });

  it("shows a dash and holds the button when the two Base RPCs disagree about the fee, saying that is why", () => {
    expect(view({ feeWei: undefined, feeUnconfirmed: true })).toEqual({
      leaves: LEAVES,
      button: {
        label: "Send it now: about –",
        note: "The bridge fee couldn't be confirmed right now (our two sources for it disagree), so it can't be sent from here yet.",
        disabled: true,
      },
    });
  });

  it("shows a dash and holds the button once the read is stale: its fee and its time may both have moved", () => {
    expect(view({}, { after: STALE_MS + 1_000 })).toEqual({
      leaves: "Leaves in –",
      button: { label: "Send it now: about –", note: "We can't read the batch on Base right now, so it can't be sent from here yet.", disabled: true },
    });
  });
});

describe("Send it now isn't offered", () => {
  it("past the max wait, or for a full batch: the keeper sends it any moment, at no cost to the user", () => {
    expect(view({ chainTime: START + DAY_S + 60 })).toEqual({ leaves: "Leaves any moment now." });
    expect(view({ chainTime: START + 600 })).toEqual({ leaves: "Leaves any moment now." });
  });

  it("when Bittensor's side can't take the batch: it says so, and that it can still be cancelled", () => {
    expect(view({ bittensor: "paused" })).toEqual({
      leaves: "Bittensor's side isn't accepting batches right now; your deposit waits on Base and you can still cancel it.",
    });
    expect(view({ bittensor: "paused" }, { what: "unstake" })).toEqual({
      leaves: "Bittensor's side isn't accepting batches right now; your unstake waits on Base and you can still cancel it.",
    });
  });

  it("when Bittensor's side couldn't be checked: it says so honestly, never as paused, and to try again", () => {
    expect(view({ bittensor: "unchecked" })).toEqual({
      leaves: "We couldn't check Bittensor's side just now; your deposit waits on Base and you can still cancel it. Try again in a minute.",
    });
    expect(view({ bittensor: undefined }, { what: "unstake" })?.leaves).toBe(
      "We couldn't check Bittensor's side just now; your unstake waits on Base and you can still cancel it. Try again in a minute.",
    );
  });

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

describe("Send it now on v3.2", () => {
  it("is offered while the front door is paused: v3.2's pause stops new stakes, never a close", () => {
    expect(button({ paused: true, closesWhilePaused: true })).toMatchObject({ label: "Send it now: about $1.74", disabled: false });
    expect(view({ paused: true, closesWhilePaused: true })?.leaves).toBe(LEAVES);
    // v3-launch's paused front door: nothing, as before
    expect(view({ paused: true })).toBeNull();
  });
});

describe("R8 (the contracts review's L-1), R9 (M-2): the stake form's offer to send the open batch first, then stake (closeFirstView)", () => {
  const FULL = "The current batch is full. It normally leaves on its own within a minute or two, at no cost to you, and the next batch then has room for your stake";
  const DUE = "The current batch has no room for this stake. It is due to leave, but it isn't full, so the keeper may hold it for more fees before sending it at no cost to you";
  /** A full batch of someone else's deposits, as the account reads it: nothing of the account's in it */
  const full = (over: Partial<OpenBatch> = {}) => batch({ mine: { depositWei: 0n, redeemShares: 0n }, totalWei: 10n ** 19n, ...over });
  /** The limits' word on it: batch 7, full by its limits, found closable by reads a refresh apart */
  const seen = (over: Partial<{ batchId: bigint; due: "full" | "time"; closableForMs: number }> = {}) => ({ batchId: 7n, due: "full" as const, closableForMs: 30_000, ...over });
  const v = (b: OpenBatch | undefined, after = seen(), unread = false) => closeFirstView({ batch: b, after, ...(unread ? { unread } : {}) });

  it("R9 (M-2): says plainly that the batch normally leaves on its own, free, within a minute or two, and that sending it now costs the bridge fee shown, with the network fee for both steps and the most the wallet sends", () => {
    expect(v(full())).toEqual({
      note: `${FULL}. It hasn't left yet, so you can send it now yourself: sending it now costs its bridge fee, about $1.74 in ETH, and Base's network fee for the two steps. Your wallet sends up to $2.26 in ETH with the close; anything extra is refunded.`,
      disabled: false,
      batchId: 7n,
    });
    // fee 0.001, pot 0.0004 at $2,000: about 0.0006 ETH to pay, 0.0009 sent
    expect(v(full({ feeWei: 10n ** 15n, potWei: 4n * 10n ** 14n, ethPriceUsd: 2_000 })).note).toBe(
      `${FULL}. It hasn't left yet, so you can send it now yourself: sending it now costs the part of its bridge fee its own fees don't cover, about $1.20 in ETH, and Base's network fee for the two steps. Your wallet sends up to $1.80 in ETH with the close; anything extra is refunded.`,
    );
    // its unstake fees cover the fee and the margin: only the network fee
    expect(v(full({ feeWei: 10n ** 15n, potWei: 2n * 10n ** 15n })).note).toBe(
      `${FULL}. It hasn't left yet, so you can send it now yourself: the fees already in it cover its bridge fee, so sending it now costs only Base's network fee for the two steps.`,
    );
  });

  it("R9 (M-2): a batch closable by time alone (under half its limits) isn't called full: it is due, and the keeper may be holding it for its fees", () => {
    const due = v(full({ totalWei: 3n * 10n ** 18n }), seen({ due: "time" }));
    expect(due.note).toBe(
      `${DUE}. It hasn't left yet, so you can send it now yourself: sending it now costs its bridge fee, about $1.74 in ETH, and Base's network fee for the two steps. Your wallet sends up to $2.26 in ETH with the close; anything extra is refunded.`,
    );
    expect(due.disabled).toBe(false);
    expect(due.note).not.toContain("is full");
    // waiting on the second read too
    expect(v(full(), seen({ due: "time", closableForMs: 0 }))).toEqual({ note: `${DUE}. If it hasn't left in a moment, you can send it yourself.`, disabled: true });
  });

  it("R9 (M-2): no paid close until two reads a refresh apart have found the same batch closable (the keeper's free round, once a minute, given a chance first): until then the button waits, saying why", () => {
    expect(CLOSE_FIRST_SEEN_MS).toBe(25_000);
    for (const ms of [0, 24_999]) expect(v(full(), seen({ closableForMs: ms })), String(ms)).toEqual({ note: `${FULL}. If it hasn't left in a moment, you can send it yourself.`, disabled: true });
    expect(v(full(), seen({ closableForMs: 25_000 })).disabled).toBe(false);
  });

  it("R10 (M-1): the limits' reading failed, or is too old to count (more than two refreshes: a hidden tab's), holds the button until a fresh one comes, saying so", () => {
    expect(closeFirstView({ batch: full(), after: seen(), limits: "old" })).toEqual({ note: `${FULL}. Checking whether it has left yet…`, disabled: true });
    expect(closeFirstView({ batch: full(), after: seen(), limits: "unread" })).toEqual({ note: `${FULL}. We couldn't check the batch again just now, so it can't be sent from here yet.`, disabled: true });
    expect(closeFirstView({ batch: full(), after: seen(), limits: "fresh" }).disabled).toBe(false);
  });

  it("R9 (L-1): an open batch read that isn't the batch the limits found closable (it just left, or a read lags the other) offers nothing until they agree", () => {
    expect(v(full({ id: 8n }))).toEqual({ note: "The batch may have just left. Checking the room again…", disabled: true });
    expect(v(full({ id: 8n }), seen({ batchId: 8n })).disabled).toBe(false);
    expect(v(full({ id: 8n }), seen({ batchId: 8n })).batchId).toBe(8n);
  });

  it("holds the button, saying why, while the batch or its fee can't be read, Bittensor's side can't take it, it can't close, deposits are paused, or the wallet is short", () => {
    expect(v(undefined)).toEqual({ note: `${FULL}. Checking what sending it costs…`, disabled: true });
    expect(v(undefined, seen(), true)).toEqual({ note: `${FULL}. We can't read the batch on Base right now, so it can't be sent from here yet.`, disabled: true });
    expect(v(full({ feeWei: undefined }))).toMatchObject({ note: expect.stringContaining("We can't read the bridge fee right now"), disabled: true });
    expect(v(full({ feeWei: undefined, feeUnconfirmed: true }))).toMatchObject({ note: expect.stringContaining("our two sources for it disagree"), disabled: true });
    expect(v(full({ bittensor: "paused" }))).toMatchObject({ note: expect.stringContaining("Bittensor's side isn't accepting batches"), disabled: true });
    expect(v(full({ bittensor: "unchecked" }))).toMatchObject({ note: expect.stringContaining("We couldn't check Bittensor's side"), disabled: true });
    expect(v(full({ canClose: false }))).toEqual({ note: "The current batch is full and can't be sent yet. Try again in a minute.", disabled: true });
    expect(v(full({ paused: true }))).toEqual({ note: "Staking is paused right now. Try again later.", disabled: true });
    // 0.000969 sent + 0.00001 for the close's gas = 0.000979 ETH at $2,330
    expect(v(full({ ethWei: 5n * 10n ** 14n }))).toMatchObject({ warning: "You need about $2.29 of ETH on Base for this.", disabled: true });
  });
});

describe("sendNowKeepsWait: what sending an unstake's batch early does not shorten", () => {
  it("names the deployment's safety wait, says there is one when its length isn't known, and nothing where there is none", () => {
    expect(sendNowKeepsWait(86_400)).toBe("Sending it now skips only the wait for the batch. The 24-hour safety wait on Bittensor still applies.");
    expect(sendNowKeepsWait(undefined)).toBe("Sending it now skips only the wait for the batch. The safety wait on Bittensor still applies.");
    expect(sendNowKeepsWait(0)).toBeNull();
  });
});
