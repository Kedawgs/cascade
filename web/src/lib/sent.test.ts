import { describe, expect, it } from "vitest";
import { BRIDGE_MINUTES, EXPECTED_DEPLOYMENTS, STAKE_MINUTES } from "./cascade/config";
import { batchNotice, depositNotice, sentCopy, sentTiming, unstakeNotice, walletTaoNotice } from "./sent";

const launch = EXPECTED_DEPLOYMENTS["v3-launch"];
/** The launch as the site is built for it: 24-hour batches at the latest, a 24-hour payout delay, v3. */
const LAUNCH = { v3: true, batchMaxWaitS: launch.batchMaxWaitS, payoutDelayS: launch.payoutDelayS };
const HOUR = 3_600;

const deposit = depositNotice("d1", { amountUsd: 50, estTao: 0.19461, batchIntervalS: HOUR });
const unstake = unstakeNotice("w1", { taoAmount: 0.07, usdcAmount: 17.41, batchIntervalS: HOUR });

describe("the panel after a deposit", () => {
  const copy = sentCopy(deposit, LAUNCH);

  it("says it's on its way, with the USDC and the TAO it should buy, and follows it on Activity", () => {
    expect(copy.title).toBe("Your deposit is on its way");
    expect(copy.rows).toEqual([
      ["Amount", "50 USDC"],
      ["TAO (estimate)", "about 0.1946 TAO"],
    ]);
    expect(copy.href).toBe("/activity?deposit=d1");
  });

  it("says what happens next by the launch's timing: hourly batches once their fees cover the bridge fee, 24 hours at the latest", () => {
    expect(LAUNCH).toEqual({ v3: true, batchMaxWaitS: 86_400, payoutDelayS: 86_400 });
    expect(copy.next).toBe(
      "Next it crosses to Bittensor in a batch: batches leave hourly once their fees cover the bridge fee, otherwise within 24 hours. It's staked about 27 minutes after it leaves.",
    );
  });

  it("gives the time from leaving to staked as the stake form's estimate counts it: the crossing and the stake", () => {
    expect(BRIDGE_MINUTES + STAKE_MINUTES).toBe(27);
    expect(copy.next).toContain(`It's staked about ${BRIDGE_MINUTES + STAKE_MINUTES} minutes after it leaves.`);
  });

  it("names no cadence it hasn't read from the front door", () => {
    expect(sentCopy({ ...deposit, batchIntervalS: undefined }, LAUNCH).next).toBe(
      "Next it crosses to Bittensor in a batch, which leaves once its fees cover the bridge fee, otherwise within 24 hours. It's staked about 27 minutes after it leaves.",
    );
  });

  it("on a deployment without a max wait, batches leave on their interval", () => {
    const test = { v3: true };
    expect(sentCopy({ ...deposit, batchIntervalS: 600 }, test).next).toBe(
      "Next it crosses to Bittensor in a batch: batches leave every 10 minutes. It's staked about 27 minutes after it leaves.",
    );
    expect(sentCopy({ ...deposit, batchIntervalS: undefined }, test).next).toBe("Next it crosses to Bittensor in a batch. It's staked about 27 minutes after it leaves.");
  });

  it("a deposit of wallet TAO gives its exact TAO, with no USDC", () => {
    const c = sentCopy(walletTaoNotice("d2", 123_456_000_000_000_000n), LAUNCH);
    expect(c.rows).toEqual([["Amount", "0.1235 TAO"]]);
    expect(c.href).toBe("/activity?deposit=d2");
  });
});

describe("the panel after an unstake", () => {
  it("says it's requested, with the TAO and the USDC it should pay, and follows it on Activity", () => {
    const copy = sentCopy(unstake, LAUNCH);
    expect(copy.title).toBe("Your unstake is requested");
    expect(copy.rows).toEqual([
      ["Unstaking", "about 0.0700 TAO"],
      ["You will receive", "about 17.41 USDC"],
    ]);
    expect(copy.href).toBe("/activity?withdrawal=w1");
  });

  it("v3: the batch, the 24-hour safety wait, then the USDC sent automatically, or a claim if TAO falls below the minimum", () => {
    expect(sentCopy(unstake, LAUNCH).next).toBe(
      "Next it goes to Bittensor in a batch: batches leave hourly once their fees cover the bridge fee, otherwise within 24 hours. After the 24-hour safety wait it comes back to Base, where it's sold at your minimum price or better and the USDC is sent to your wallet. If TAO's price falls below your minimum, it waits for you to claim it instead.",
    );
  });

  it("v2: back on Base it waits to be claimed; a delay that isn't known isn't named", () => {
    expect(sentCopy({ ...unstake, batchIntervalS: undefined }, { v3: false }).next).toBe(
      "Next it goes to Bittensor in a batch. After a safety wait it comes back to Base, where you claim it as USDC from its receipt.",
    );
    expect(sentCopy({ ...unstake, batchIntervalS: undefined }, { v3: false, payoutDelayS: 0 }).next).toBe(
      "Next it goes to Bittensor in a batch. Then it comes back to Base, where you claim it as USDC from its receipt.",
    );
  });
});

describe("the panel after Send it now", () => {
  it("says the batch is on its way, what the user paid toward its bridge fee, and follows it from where it was sent", () => {
    const copy = sentCopy(batchNotice("/activity?deposit=d1", { outcome: "sent", paidWei: 744_898_037_875_672n, ethPriceUsd: 2_330 }), LAUNCH);
    expect(copy.title).toBe("Your batch is on its way to Bittensor");
    expect(copy.rows).toEqual([["Bridge fee you paid", "$1.74 in ETH"]]);
    expect(copy.next).toBe("It reaches Bittensor in about 20–30 minutes; your receipts in Activity follow it from here. Anything you sent beyond the fee is back in your wallet.");
    expect(copy.href).toBe("/activity?deposit=d1");
  });

  it("says so when the batch's own fees paid it all, gives ETH without a price, under $0.01 for a tiny fee, and nothing it couldn't read", () => {
    expect(sentCopy(batchNotice("/activity", { outcome: "sent", paidWei: 0n, ethPriceUsd: 2_330 }), LAUNCH).rows).toEqual([["Bridge fee you paid", "nothing: the batch's fees covered it"]]);
    expect(sentCopy(batchNotice("/activity", { outcome: "sent", paidWei: 744_898_037_875_672n }), LAUNCH).rows).toEqual([["Bridge fee you paid", "0.000745 ETH"]]);
    expect(sentCopy(batchNotice("/activity", { outcome: "sent", paidWei: 10n ** 12n, ethPriceUsd: 2_330 }), LAUNCH).rows).toEqual([["Bridge fee you paid", "under $0.01 in ETH"]]);
    // the receipt couldn't be read: no figure in place of the one it would have given
    expect(sentCopy(batchNotice("/activity", { ethPriceUsd: 2_330 }), LAUNCH).rows).toEqual([]);
  });

  it("says what happened when the batch had already left: only a roll, everything back but the network fee", () => {
    const copy = sentCopy(batchNotice("/activity?deposit=d1", { outcome: "rolled", ethPriceUsd: 2_330 }), LAUNCH);
    expect(copy.title).toBe("Your batch had already left");
    expect(copy.rows).toEqual([]);
    expect(copy.next).toBe("It had already left; your ETH came back except the network fee. Your receipts in Activity follow it from here.");
  });

  it("says what happened when a different batch was sent in its place, and what that one's fee took", () => {
    const copy = sentCopy(batchNotice("/activity?deposit=d1", { outcome: "other", paidWei: 744_898_037_875_672n, ethPriceUsd: 2_330 }), LAUNCH);
    expect(copy.title).toBe("Your batch had already left");
    expect(copy.rows).toEqual([["Bridge fee you paid", "$1.74 in ETH"]]);
    expect(copy.next).toBe("A different batch was sent; your ETH beyond the fee came back. Yours had already left, and your receipts in Activity follow it from here.");
  });
});

describe("sentTiming", () => {
  it("reads the deployment's pinned timing, and none without a deployment", () => {
    expect(sentTiming({ batchMaxWaitS: 86_400, payoutDelayS: 86_400 }, true)).toEqual(LAUNCH);
    expect(sentTiming(null, false)).toEqual({ v3: false });
  });
});
