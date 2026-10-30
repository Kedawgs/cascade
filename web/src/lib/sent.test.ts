import { describe, expect, it } from "vitest";
import { BRIDGE_MINUTES, EXPECTED_DEPLOYMENTS, STAKE_MINUTES } from "./cascade/config";
import { depositNotice, sentCopy, sentTiming, unstakeNotice, walletTaoNotice } from "./sent";

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

describe("sentTiming", () => {
  it("reads the deployment's pinned timing, and none without a deployment", () => {
    expect(sentTiming({ batchMaxWaitS: 86_400, payoutDelayS: 86_400 }, true)).toEqual(LAUNCH);
    expect(sentTiming(null, false)).toEqual({ v3: false });
  });
});
