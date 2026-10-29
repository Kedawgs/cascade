import { describe, expect, it } from "vitest";
import type { DepositOp, WithdrawalOp } from "./oplog";
import { chainOnlyDeposit, type DepositFacts, depositRecord, isDelivering, offersClaim, type WithdrawalFacts, withdrawalRecord } from "./trail";

const ME = "0x000000000000000000000000000000000000A11c" as const;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const T0 = new Date("2026-10-25T10:00:00Z");

const op: DepositOp = {
  id: "d1",
  kind: "deposit",
  account: ME,
  createdAt: T0.getTime(),
  usdcIn: 20_000_000n,
  targetTao: 78_000_000_000_000_000n,
  priceUsd: 251.6,
  feesUsd: 0.08,
  mode: "sequential",
  hashes: { swap: H(1), deposit: H(2) },
  batchId: 3n,
  state: "sent",
};

const base: DepositFacts = {
  swapMined: true,
  depositMined: true,
  openBatchId: 3n,
  now: new Date("2026-10-25T10:05:00Z"),
  closesAt: new Date("2026-10-25T10:10:00Z"),
  waitingForMinimum: false,
  stillOpen: true,
};

const statuses = (r: { steps: { status: string }[] }) => r.steps.map((s) => s.status);

describe("deposit trail with a max wait", () => {
  it("words the close time as an upper bound, with the day when it is not today", () => {
    const same = depositRecord(op, { ...base, closesBy: true });
    expect(same.steps[2].detail).toMatch(/^Waits for the batch to close, by about 10:10 AM, then the bridge/);
    expect(same.steps[2].detail).not.toMatch(/tomorrow/);
    const next = depositRecord(op, { ...base, closesBy: true, now: new Date(2026, 9, 25, 10, 5), closesAt: new Date(2026, 9, 26, 14, 5) });
    expect(next.steps[2].detail).toMatch(/close, by about 2:05 PM tomorrow, then/);
    expect(depositRecord(op, base).steps[2].detail).toMatch(/^Waits for the batch to close at /);
  });
});

describe("deposit trail", () => {
  it("waits in the open batch, saying when it closes", () => {
    const r = depositRecord(op, base);
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[2].detail).toMatch(/10:10 AM/);
    expect(r.cancellableWei).toBe(78_000_000_000_000_000n);
    expect(r.amountUsd).toBe(20);
    expect(r.status).toBe("in_progress");
  });

  it("says at what price only for a deposit recorded with one", () => {
    expect(depositRecord(op, base).taoPriceUsd).toBe(251.6);
    const unpriced: DepositOp = { ...op };
    delete unpriced.priceUsd;
    expect(depositRecord(unpriced, base)).not.toHaveProperty("taoPriceUsd");
    // wallet-TAO deposits were once recorded at $0 when no price was at hand
    expect(depositRecord({ ...op, priceUsd: 0 }, base)).not.toHaveProperty("taoPriceUsd");
  });

  it("marks a stopped deposit that never sent anything, so it can be removed", () => {
    const stopped = { ...op, state: "needs-you" as const, hashes: {} };
    const none = { ...base, swapMined: false, depositMined: false };
    expect(depositRecord(stopped, none).nothingSent).toBe(true);
    expect(depositRecord({ ...stopped, hashes: { approveUsdc: H(1) } }, none).nothingSent).toBeUndefined();
    expect(depositRecord({ ...stopped, callsId: "0xabc" }, none).nothingSent).toBeUndefined();
    expect(depositRecord({ ...op, state: "running" as const, hashes: {} }, none).nothingSent).toBeUndefined();
  });

  it("does not offer removal for a flow interrupted moments ago: its wallet prompt may still be open", () => {
    const left = { ...op, state: "needs-you" as const, hashes: {} };
    const none = { ...base, swapMined: false, depositMined: false, interrupted: true };
    expect(depositRecord(left, { ...none, now: new Date(T0.getTime() + 2 * 60_000) }).nothingSent).toBeUndefined();
    expect(depositRecord(left, { ...none, now: new Date(T0.getTime() + 15 * 60_000) }).nothingSent).toBe(true);
  });

  it("gives the bridge an expected arrival when it knows when the batch was sent", () => {
    const r = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, sentAt: new Date("2026-10-25T10:12:00Z") });
    expect(r.steps[2].detail).toMatch(/expected around 10:32 AM/);
  });

  it("shows what the swap really spent once it is known, not the most it could spend", () => {
    expect(depositRecord(op, { ...base, usdcSpent: 19_903_212n }).amountUsd).toBeCloseTo(19.903212, 6);
    expect(depositRecord(op, base).amountUsd).toBe(20);
  });

  it("explains a failed step with the saved reason, and offers to try again or remove it when nothing was sent", () => {
    const failed = { ...op, state: "failed" as const, hashes: {}, error: "The price moved past your 0.5% limit, so the swap was undone." };
    const r = depositRecord(failed, { ...base, swapMined: false, depositMined: false });
    expect(r.steps[0].status).toBe("failed");
    expect(r.steps[0].detail).toBe("The price moved past your 0.5% limit, so the swap was undone.");
    expect(r.retryable).toBeUndefined();
    expect(r.restake).toBe(true);
    expect(r.nothingSent).toBe(true);
  });

  it("offers a fresh stake, not a retry, when the swap itself reverted (its hash is saved, so a retry would only re-read it)", () => {
    const reverted = { ...op, state: "failed" as const, hashes: { approveUsdc: H(1), swap: H(2) }, error: "The price moved past your 0.5% limit, so the swap was undone." };
    const r = depositRecord(reverted, { ...base, swapMined: false, depositMined: false });
    expect(r.restake).toBe(true);
    expect(r.retryable).toBeUndefined();
    const batch = { ...op, state: "failed" as const, hashes: {}, callsId: "0xabc", error: "x" };
    expect(depositRecord(batch, { ...base, swapMined: false, depositMined: false }).restake).toBe(true);
  });

  it("after a swap that worked but a deposit that failed, says the TAO is in the wallet", () => {
    const failed = { ...op, state: "failed" as const, hashes: { swap: H(1) }, error: "The deposit didn't go through." };
    const r = depositRecord(failed, { ...base, swapMined: true, depositMined: false });
    expect(r.steps[1].status).toBe("failed");
    expect(r.steps[1].detail).toMatch(/didn't go through/);
    expect(r.steps[1].detail).toMatch(/in your wallet/);
    expect(r.retryable).toBe(true);
    expect(r.nothingSent).toBeUndefined();
  });

  it("says the batch can close now once its time has passed", () => {
    const r = depositRecord(op, { ...base, now: new Date("2026-10-25T10:20:00Z") });
    expect(r.steps[2].detail).toMatch(/can close now/i);
    expect(r.steps[2].detail).not.toMatch(/10:10/);
  });

  it("shows a deposit taken back before the batch closed as cancelled", () => {
    const r = depositRecord({ ...op, cancelled: { hash: H(12), at: T0.getTime() } }, { ...base, cancelMined: true });
    expect(r.status).toBe("cancelled");
    expect(r.cancellableWei).toBeUndefined();
    expect(r.steps[2]).toMatchObject({ status: "failed" });
    expect(r.steps[2].detail).toMatch(/back in your wallet/i);
  });

  it("stays cancelled after its batch is delivered with other people's deposits", () => {
    const delivered = { at: new Date("2026-10-25T10:35:00Z"), txHash: H(9), outcome: "deposited" as const };
    const r = depositRecord(
      { ...op, cancelled: { hash: H(12), at: T0.getTime() } },
      { ...base, openBatchId: 4n, stillOpen: false, delivered, staked: { at: new Date(), txHash: H(7) }, cancelMined: true },
    );
    expect(r.status).toBe("cancelled");
    expect(statuses(r)).toEqual(["done", "done", "failed", "pending"]);
    expect(r.steps[2].detail).toMatch(/back in your wallet/i);
    expect(r.cancellableWei).toBeUndefined();
  });

  it("is on the bridge once the batch has closed, saying for how long and where to watch it", () => {
    const r = depositRecord(op, {
      ...base,
      openBatchId: 4n,
      stillOpen: false,
      depositedAt: new Date("2026-10-25T09:53:00Z"),
      watchUrl: "https://ccip.chain.link/address/0x221C",
    });
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[2].detail).toMatch(/deposited 12 minutes ago/);
    expect(r.steps[2].detail).toMatch(/finalize/);
    expect(r.steps[2].txUrl).toBe("https://ccip.chain.link/address/0x221C");
    expect(r.cancellableWei).toBeUndefined();
  });

  it("is in the vault after delivery, then staked", () => {
    const delivered = { at: new Date("2026-10-25T10:35:00Z"), txHash: H(9), messageId: H(8), outcome: "deposited" as const };
    const arrived = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, delivered });
    expect(statuses(arrived)).toEqual(["done", "done", "done", "active"]);
    expect(arrived.steps[2].txUrl).toContain(H(9));
    const staked = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, delivered, staked: { at: new Date(), txHash: H(7) } });
    expect(statuses(staked)).toEqual(["done", "done", "done", "done"]);
    expect(staked.status).toBe("staked");
  });

  it("explains a vault still waiting for the 0.02-TAO minimum, with how much it holds and how much is missing", () => {
    const delivered = { at: new Date(), txHash: H(9), outcome: "deposited" as const };
    const r = depositRecord(op, {
      ...base,
      openBatchId: 4n,
      stillOpen: false,
      delivered,
      waitingForMinimum: true,
      vaultWei: 11_749_608n * 10n ** 9n,
      minimumWei: 2n * 10n ** 16n,
    });
    expect(r.steps[3].status).toBe("active");
    expect(r.steps[3].detail).toMatch(/0\.02 TAO/);
    expect(r.steps[3].detail).toMatch(/holds 0\.0117 TAO/);
    expect(r.steps[3].detail).toMatch(/0\.0083 TAO more/);
    expect(r.steps[3].detail).toMatch(/not earning/i);
    expect(r.steps[3].summary).toBe("waiting for the 0.02 TAO minimum");
  });

  it("says no more is needed when the user's own deposit on its way covers the minimum", () => {
    const delivered = { at: new Date(), txHash: H(9), outcome: "deposited" as const };
    const waiting = { ...base, openBatchId: 4n, stillOpen: false, delivered, waitingForMinimum: true, vaultWei: 11_749_608n * 10n ** 9n, minimumWei: 2n * 10n ** 16n };
    const covered = depositRecord(op, { ...waiting, incomingWei: 78_336_398n * 10n ** 9n });
    expect(covered.steps[3].detail).toMatch(/0\.0783 TAO deposit on its way/);
    expect(covered.steps[3].detail).toMatch(/nothing for you to do/i);
    expect(covered.steps[3].detail).not.toMatch(/more arrives/);
    const short = depositRecord(op, { ...waiting, incomingWei: 10n ** 15n });
    expect(short.steps[3].detail).toMatch(/with your 0\.0010 TAO deposit on its way, it is staked once 0\.0073 TAO more arrives/);
  });

  it("rounds what the vault holds down and what is missing up, and shows the live minimum as it is", () => {
    const delivered = { at: new Date(), txHash: H(9), outcome: "deposited" as const };
    const almost = depositRecord(op, {
      ...base,
      openBatchId: 4n,
      stillOpen: false,
      delivered,
      waitingForMinimum: true,
      vaultWei: 19_996n * 10n ** 12n,
      minimumWei: 2n * 10n ** 16n,
    });
    expect(almost.steps[3].detail).toMatch(/holds 0\.0199 TAO/);
    expect(almost.steps[3].detail).toMatch(/0\.0001 TAO more/);
    const odd = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, delivered, waitingForMinimum: true, minimumWei: 25n * 10n ** 15n });
    expect(odd.steps[3].detail).toMatch(/the 0\.025 TAO minimum/);
    expect(odd.steps[3].summary).toBe("waiting for the 0.025 TAO minimum");
  });

  it("marks a bounced delivery as failed", () => {
    const r = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, delivered: { at: new Date(), txHash: H(9), outcome: "bounced" } });
    expect(r.steps[2].status).toBe("failed");
    expect(r.status).toBe("failed");
  });

  it("asks the user to carry on when a step is waiting in the wallet", () => {
    const r = depositRecord({ ...op, hashes: { swap: H(1) }, batchId: undefined, state: "needs-you" }, { ...base, depositMined: false });
    expect(statuses(r)).toEqual(["done", "action", "pending", "pending"]);
    expect(r.status).toBe("needs_you");
  });

  it("shows a deposit found only on-chain without dollar figures", () => {
    const r = chainOnlyDeposit({ key: H(5), txHash: H(9), at: new Date(), assets: 10n ** 16n, staked: true });
    expect(r.amountUsd).toBeUndefined();
    expect(r.taoAmount).toBeCloseTo(0.01, 10);
    expect(r.status).toBe("staked");
  });
});

describe("v3 deposit trail (one stake through CascadeStaker)", () => {
  const op3: DepositOp = { ...op, v: 3, minTaoOut: 77_611_000_000_000_000n, hashes: { stake: H(5) } };

  it("marks the swap and the deposit done together from the one stake receipt, both linking to it", () => {
    const r = depositRecord(op3, { ...base, taoDeposited: 77_700_000_000_000_000n });
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[0].txUrl).toContain(H(5));
    expect(r.steps[1].txUrl).toContain(H(5));
    // the TAO the front door recorded, which the cancel must ask for exactly
    expect(r.taoWei).toBe(77_700_000_000_000_000n);
    expect(r.cancellableWei).toBe(77_700_000_000_000_000n);
  });

  it("offers 'Stake again at today's price' for a stake that reverted, never a retry of the deposit alone", () => {
    const failed = { ...op3, state: "failed" as const, error: "The price moved before the stake went through, so no USDC left your wallet." };
    const r = depositRecord(failed, { ...base, swapMined: false, depositMined: false });
    expect(statuses(r)).toEqual(["failed", "pending", "pending", "pending"]);
    expect(r.steps[0].detail).toMatch(/price moved/);
    expect(r.status).toBe("failed");
    expect(r.restake).toBe(true);
    expect(r.retryable).toBeUndefined();
  });

  it("waits for the user after a declined signature, and can be removed since nothing was sent", () => {
    const stopped = { ...op3, hashes: {}, state: "needs-you" as const, error: "You declined the signature in your wallet." };
    const r = depositRecord(stopped, { ...base, swapMined: false, depositMined: false });
    expect(r.status).toBe("needs_you");
    expect(r.steps[0]).toMatchObject({ status: "action", detail: "You declined the signature in your wallet." });
    expect(r.nothingSent).toBe(true);
  });
});

const wop: WithdrawalOp = {
  id: "w1",
  kind: "withdrawal",
  account: ME,
  createdAt: T0.getTime(),
  shares: 10n ** 22n,
  taoEstimate: 10n ** 16n,
  usdcEstimate: 2_500_000n,
  fee: 10n ** 14n,
  hash: H(3),
  batchId: 5n,
  state: "sent",
};

const wbase: WithdrawalFacts = {
  requestMined: true,
  openBatchId: 5n,
  now: new Date("2026-10-25T10:05:00Z"),
  closesAt: new Date("2026-10-25T10:10:00Z"),
  stillOpen: true,
  claimable: 0n,
  payoutDelay: 3600,
};

describe("withdrawal trail with a max wait", () => {
  it("words the close time as an upper bound, with the day when it is not today", () => {
    const same = withdrawalRecord(wop, { ...wbase, closesBy: true });
    expect(same.steps[1].detail).toBe("Waits for the batch to close, by about 10:10 AM, then the bridge");
    const next = withdrawalRecord(wop, { ...wbase, closesBy: true, now: new Date(2026, 9, 25, 10, 5), closesAt: new Date(2026, 9, 26, 14, 5) });
    expect(next.steps[1].detail).toBe("Waits for the batch to close, by about 2:05 PM tomorrow, then the bridge");
    // without a max wait: the close time itself, as before
    expect(withdrawalRecord(wop, wbase).steps[1].detail).toBe("Waits for the batch to close at 10:10 AM, then the bridge");
    // past the time: it can close now, either way
    expect(withdrawalRecord(wop, { ...wbase, closesBy: true, now: new Date("2026-10-25T10:20:00Z") }).steps[1].detail).toMatch(/^The batch can close now/);
  });
});

describe("withdrawal trail", () => {
  it("goes from requested to unstaked to returning", () => {
    expect(statuses(withdrawalRecord(wop, wbase))).toEqual(["done", "active", "pending", "pending"]);
    const redeemed = { at: new Date("2026-10-25T10:35:00Z"), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const r = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed });
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[2].detail).toMatch(/safety wait ends around 11:35 AM/);
    expect(r.steps[0].title).toBe("Request your unstake");
    expect(r.steps[0].detail).toBeUndefined();
    const flying = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout: { txHash: H(4), messageId: H(6), state: 1, at: new Date() } });
    expect(flying.steps[2].txUrl).toContain(H(6));
  });

  it("gives the unstake's bridge leg how long so far, an expected arrival and Chainlink's explorer", () => {
    const r = withdrawalRecord(wop, {
      ...wbase,
      openBatchId: 6n,
      stillOpen: false,
      now: new Date("2026-10-25T10:20:00Z"),
      requestedAt: new Date("2026-10-25T10:05:00Z"),
      sentAt: new Date("2026-10-25T10:12:00Z"),
      watchUrl: "https://ccip.chain.link/address/0x221C",
    });
    expect(r.steps[1].detail).toMatch(/requested 15 minutes ago/);
    expect(r.steps[1].detail).toMatch(/expected around 10:32 AM/);
    expect(r.steps[1].txUrl).toBe("https://ccip.chain.link/address/0x221C");
  });

  it("explains an unstake that took nothing, in plain words, offers to unstake again and promises no payout", () => {
    const at = new Date();
    const skipped = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: { at, txHash: H(9), outcome: "skipped" as const, taoWei: 0n } });
    expect(skipped.steps[1].detail).toBe("There was no stake to take when this request arrived, so nothing was taken.");
    expect(skipped.unstakeAgain).toBe(true);
    expect(skipped.usdcAmount).toBeUndefined();
    const limited = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: { at, txHash: H(9), outcome: "deferred" as const, taoWei: 0n } });
    expect(limited.steps[1].detail).toBe("The daily unstake limit was reached, so nothing was taken. You can unstake again tomorrow.");
    expect(limited.unstakeAgain).toBe(true);
  });

  it("is ready to claim only once its own payout has reached Base, not whenever something is claimable", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const waiting = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, claimable: 5n * 10n ** 15n });
    expect(waiting.status).toBe("in_progress");
    expect(waiting.steps[3].status).toBe("pending");
    const landed = withdrawalRecord(wop, {
      ...wbase,
      openBatchId: 6n,
      stillOpen: false,
      delivered: redeemed,
      claimable: 5n * 10n ** 15n,
      payout: { txHash: H(4), messageId: H(6), state: 2, at: new Date() },
    });
    expect(landed.status).toBe("ready");
    expect(landed.steps[3].status).toBe("action");
  });

  it("calls a payout the bridge hasn't delivered yet delayed, not a problem", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const r = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout: { txHash: H(4), messageId: H(6), state: 3, at: new Date() } });
    expect(r.steps[2].status).toBe("active");
    expect(r.steps[2].detail).toMatch(/hasn't delivered this payout yet/);
    expect(r.status).toBe("in_progress");
  });

  it("asks the user to claim once the TAO is back on Base, then shows it paid", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const payout = { txHash: H(4), messageId: H(6), state: 2 as const, at: new Date() };
    const ready = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 99n * 10n ** 14n });
    expect(statuses(ready)).toEqual(["done", "done", "done", "action"]);
    expect(ready.status).toBe("ready");
    const claimed = { hash: H(11), at: new Date(), taoClaimed: 99n * 10n ** 14n, usdcOut: 2_450_000n, keptTao: false, swapFailed: false };
    const paid = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 0n, claimed });
    expect(paid.status).toBe("paid");
    expect(statuses(paid)).toEqual(["done", "done", "done", "done"]);
    expect(paid.received).toEqual({ usdc: 2.45 });
    const kept = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 0n, claimed: { ...claimed, usdcOut: undefined, keptTao: true } });
    expect(kept.received).toEqual({ keptTao: 0.0099 });
    expect(kept.steps[3].title).toMatch(/kept as TAO/i);
  });

  it("says when the claim went through but the swap back to USDC did not", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const payout = { txHash: H(4), messageId: H(6), state: 2 as const, at: new Date() };
    const r = withdrawalRecord(wop, {
      ...wbase,
      openBatchId: 6n,
      stillOpen: false,
      delivered: redeemed,
      payout,
      claimable: 0n,
      claimed: { hash: H(11), at: new Date(), taoClaimed: 99n * 10n ** 14n, keptTao: false, swapFailed: true },
    });
    expect(r.status).toBe("needs_you");
    expect(r.steps[3]).toMatchObject({ status: "action" });
    expect(r.steps[3].detail).toMatch(/in your wallet/i);
  });

  it("shows a request taken back as cancelled, noting the fee is kept", () => {
    const r = withdrawalRecord({ ...wop, cancelled: { hash: H(13), at: T0.getTime() } }, { ...wbase, cancelMined: true });
    expect(r.status).toBe("cancelled");
    expect(r.cancellableShares).toBeUndefined();
    expect(r.steps[1].detail).toMatch(/fee/i);
  });

  it("stays cancelled when its batch is delivered with another request of the account's", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const payout = { txHash: H(4), messageId: H(6), state: 2 as const, at: new Date() };
    const r = withdrawalRecord(
      { ...wop, cancelled: { hash: H(13), at: T0.getTime() } },
      { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 99n * 10n ** 14n, cancelMined: true },
    );
    expect(r.status).toBe("cancelled");
    expect(statuses(r)).toEqual(["done", "failed", "pending", "pending"]);
    expect(r.steps[1].detail).toMatch(/Cancelled/);
    expect(r.taoAmount).toBe(0.01);
    expect(offersClaim(r)).toBe(false);
  });

  it("marks a skipped redeem as failed (a payout the bridge hasn't delivered is delayed, tested above)", () => {
    const skipped = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: { at: new Date(), txHash: H(9), outcome: "skipped" } });
    expect(skipped.steps[1].status).toBe("failed");
  });

  it("lets a request still in the open batch be cancelled", () => {
    expect(withdrawalRecord(wop, wbase).cancellableShares).toBe(10n ** 22n);
  });
});

describe("v3 withdrawal trail (USDC delivered to the wallet automatically)", () => {
  const DEADLINE = Math.floor(T0.getTime() / 1000) + 604_800;
  const asked = { minUsdcPerTao: 245_000_000n, deadline: DEADLINE };
  const wop3: WithdrawalOp = { ...wop, delivery: asked };
  const CREDIT = 99n * 10n ** 14n;
  const redeemed = { at: new Date("2026-10-25T10:35:00Z"), txHash: H(9), outcome: "redeemed" as const, taoWei: CREDIT };
  const payout = { txHash: H(4), messageId: H(6), state: 2 as const, at: new Date("2026-10-25T11:40:00Z") };
  // back on Base 25 minutes ago, nothing has taken it yet: 0.0099 TAO waits in the front door
  const back: WithdrawalFacts = {
    ...wbase,
    openBatchId: 6n,
    stillOpen: false,
    delivered: redeemed,
    payout,
    now: new Date("2026-10-25T12:10:00Z"),
    claimable: CREDIT,
    credited: { at: new Date("2026-10-25T11:45:00Z"), taoWei: CREDIT },
    preference: asked,
  };
  const receipt = { hash: H(30), at: new Date("2026-10-25T11:50:00Z"), usdcOut: 2_431_337n };
  const claimed = { hash: H(11), at: new Date(), taoClaimed: CREDIT, usdcOut: 2_450_000n, keptTao: false, swapFailed: false };

  it("waits for its payout to reach Base before anything can be delivered", () => {
    const r = withdrawalRecord(wop3, { ...back, payout: { ...payout, state: 1 }, credited: undefined });
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.status).toBe("in_progress");
    expect(offersClaim(r)).toBe(false);
  });

  it("shows 'USDC delivered' with the amount from the Delivered log and a link to its receipt", () => {
    const r = withdrawalRecord(wop3, { ...back, claimable: 0n, usdcDelivered: receipt });
    expect(statuses(r)).toEqual(["done", "done", "done", "done"]);
    expect(r.steps[3]).toMatchObject({ title: "USDC delivered", status: "done", at: receipt.at });
    expect(r.steps[3].txUrl).toContain(H(30));
    expect(r.status).toBe("paid");
    expect(r.received).toEqual({ usdc: 2.431337 });
    // what arrived, not the estimate
    expect(r.usdcAmount).toBe(2.431337);
  });

  it("finds the delivery even when a later payout is waiting on Base", () => {
    const r = withdrawalRecord(wop3, { ...back, claimable: 5n * 10n ** 15n, usdcDelivered: receipt });
    expect(r.status).toBe("paid");
    expect(r.steps[3].status).toBe("done");
  });

  it("shows one delivery that sold two payouts together without a per-unstake amount: its receipt and the total", () => {
    const r = withdrawalRecord(wop3, { ...back, claimable: 0n, usdcDelivered: { ...receipt, usdcOut: 4_862_674n, shared: true } });
    expect(r.status).toBe("paid");
    expect(r.steps[3]).toMatchObject({ title: "USDC delivered", status: "done", detail: "Delivered together with your other payout: 4.86 USDC in all" });
    expect(r.steps[3].txUrl).toContain(H(30));
    expect(r.received).toBeUndefined();
    expect(r.usdcAmount).toBeUndefined();
  });

  it("says USDC is on its way automatically while the delivery preference is live", () => {
    const r = withdrawalRecord(wop3, back);
    expect(statuses(r)).toEqual(["done", "done", "done", "active"]);
    expect(r.steps[3].detail).toBe("USDC is being delivered to your wallet automatically");
    expect(r.status).toBe("in_progress");
    expect(offersClaim(r)).toBe(false);
    expect(r.received).toBeUndefined();
    // the preference couldn't be read: the one this unstake asked for stands in
    expect(withdrawalRecord(wop3, { ...back, preference: undefined }).steps[3].status).toBe("active");
  });

  it("marks an unstake still on its way back with automatic delivery ahead, which a claim by hand would turn off", () => {
    // in the open batch, on the bridge, in the safety wait, on the way back to Base
    expect(withdrawalRecord(wop3, wbase).awaitingDelivery).toBe(true);
    expect(withdrawalRecord(wop3, { ...back, payout: undefined, credited: undefined, claimable: 0n, preference: undefined }).awaitingDelivery).toBe(true);
    expect(withdrawalRecord(wop3, { ...back, payout: { ...payout, state: 1 }, credited: undefined, preference: undefined }).awaitingDelivery).toBe(true);
    // landed (being delivered, or offering the claim), paid, or never going to be delivered: not
    expect(withdrawalRecord(wop3, back).awaitingDelivery).toBeUndefined();
    expect(withdrawalRecord(wop3, { ...back, claimable: 0n, usdcDelivered: receipt }).awaitingDelivery).toBeUndefined();
    expect(withdrawalRecord(wop3, { ...wbase, now: new Date((DEADLINE + 1) * 1000) }).awaitingDelivery).toBeUndefined();
    expect(withdrawalRecord(wop3, { ...wbase, requestMined: false }).awaitingDelivery).toBeUndefined();
    expect(withdrawalRecord({ ...wop3, cancelled: { hash: H(12), at: T0.getTime() } }, { ...wbase, cancelMined: true }).awaitingDelivery).toBeUndefined();
    expect(
      withdrawalRecord(wop3, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: { ...redeemed, outcome: "skipped" as const, taoWei: 0n } }).awaitingDelivery,
    ).toBeUndefined();
    // v2 delivers nothing automatically
    expect(withdrawalRecord(wop, wbase).awaitingDelivery).toBeUndefined();
  });

  it("tells the screens when an unstake's USDC is on its way by itself", () => {
    expect(isDelivering(withdrawalRecord(wop3, back))).toBe(true);
    // taking longer than usual: the claim is offered, so it no longer counts as delivering
    expect(isDelivering(withdrawalRecord(wop3, { ...back, now: new Date("2026-10-25T12:46:00Z") }))).toBe(false);
    expect(isDelivering(withdrawalRecord(wop3, { ...back, preference: null }))).toBe(false);
    expect(isDelivering(withdrawalRecord(wop3, { ...back, payout: { ...payout, state: 1 }, credited: undefined }))).toBe(false);
    expect(isDelivering(withdrawalRecord(wop3, { ...back, claimable: 0n, usdcDelivered: receipt }))).toBe(false);
  });

  it("offers the claim as well once delivery is taking longer than usual: an hour after the payout landed", () => {
    const slow = withdrawalRecord(wop3, { ...back, now: new Date("2026-10-25T12:46:00Z") });
    expect(slow.steps[3]).toMatchObject({ title: "USDC to your wallet", status: "action" });
    expect(slow.steps[3].detail).toBe(
      "USDC is being delivered to your wallet automatically. It's taking longer than usual. You can keep waiting, or claim it as USDC now.",
    );
    expect(slow.status).toBe("ready");
    expect(offersClaim(slow)).toBe(true);
    expect(offersClaim(withdrawalRecord(wop3, { ...back, now: new Date("2026-10-25T12:44:00Z") }))).toBe(false);
    // when it landed isn't known: the payout left Bittensor at 11:40, plus 30 minutes on the bridge, plus the hour
    const unknown = { ...back, credited: undefined, traceFailed: true as const };
    expect(offersClaim(withdrawalRecord(wop3, { ...unknown, now: new Date("2026-10-25T13:09:00Z") }))).toBe(false);
    expect(offersClaim(withdrawalRecord(wop3, { ...unknown, now: new Date("2026-10-25T13:11:00Z") }))).toBe(true);
  });

  it("offers 'Claim as USDC' once the preference has expired, or when there is none", () => {
    const expired = withdrawalRecord(wop3, { ...back, preference: { ...asked, deadline: Math.floor(back.now.getTime() / 1000) - 1 } });
    expect(expired.steps[3]).toMatchObject({ title: "Claim as USDC", status: "action" });
    expect(expired.status).toBe("ready");
    expect(offersClaim(expired)).toBe(true);
    const none = withdrawalRecord(wop3, { ...back, preference: null });
    expect(none.steps[3]).toMatchObject({ title: "Claim as USDC", status: "action", detail: "Your money is back on Base. Claim it as USDC" });
    expect(none.status).toBe("ready");
  });

  it("offers 'Claim as USDC' when today's price is under the minimum, since it can't be delivered at that price", () => {
    // the floor on 0.0099 TAO at 245 USDC per TAO is 2.4255 USDC
    const under = withdrawalRecord(wop3, { ...back, saleNowUsdc: 2_400_000n });
    expect(under.steps[3]).toMatchObject({ title: "Claim as USDC", status: "action" });
    expect(under.steps[3].detail).toMatch(/below your minimum/);
    expect(under.status).toBe("ready");
    const over = withdrawalRecord(wop3, { ...back, saleNowUsdc: 2_425_500n });
    expect(over.steps[3].status).toBe("active");
  });

  it("while the price is under the minimum, gives what the payout would sell for today, not the estimate from the request", () => {
    const under = withdrawalRecord(wop3, { ...back, saleNowUsdc: 2_400_000n });
    expect(under.belowMinimum).toEqual({ usdcNow: 2.4 });
    // two payouts waiting, sold together: this one's share of the sale
    const two = withdrawalRecord(wop3, { ...back, claimable: 2n * CREDIT, saleNowUsdc: 4_800_000n });
    expect(two.steps[3].detail).toMatch(/below your minimum/);
    expect(two.belowMinimum).toEqual({ usdcNow: 2.4 });
    // what this payout was credited can't be read: no figure rather than one that may be shared
    const unknown = withdrawalRecord(wop3, { ...back, credited: undefined, traceFailed: true, saleNowUsdc: 2_400_000n });
    expect(unknown.steps[3].detail).toMatch(/below your minimum/);
    expect(unknown.belowMinimum).toEqual({});
    // at or over the minimum, and on v2, there is no such state
    expect(withdrawalRecord(wop3, { ...back, saleNowUsdc: 2_425_500n }).belowMinimum).toBeUndefined();
    expect(withdrawalRecord(wop3, back).belowMinimum).toBeUndefined();
    expect(withdrawalRecord(wop, { ...back, saleNowUsdc: 2_400_000n }).belowMinimum).toBeUndefined();
  });

  it("stays 'Claim as USDC' in progress while a claim from this browser settles, whatever is claimable", () => {
    for (const claimable of [0n, CREDIT]) {
      const r = withdrawalRecord(wop3, { ...back, claimable, preference: null, claimPending: true });
      expect(r.steps[3]).toMatchObject({ title: "Claim as USDC", status: "active" });
      expect(r.status).toBe("in_progress");
      expect(offersClaim(r)).toBe(false);
    }
  });

  it("shows no amount when the logs can't be read, with the status still right: nothing claimable and no claim made", () => {
    const r = withdrawalRecord(wop3, { ...back, claimable: 0n, traceFailed: true });
    expect(r.steps[3]).toMatchObject({ title: "Paid out", status: "done" });
    expect(r.steps[3].txUrl).toBeUndefined();
    expect(r.status).toBe("paid");
    expect(r.received).toBeUndefined();
    expect(r.usdcAmount).toBeUndefined();
  });

  it("doesn't call it paid when the logs were read and show nothing taking it, or no credit for this account", () => {
    // credited, and nothing after it: the empty balance is an older read, not a payment
    const untaken = withdrawalRecord(wop3, { ...back, claimable: 0n });
    expect(untaken.status).toBe("in_progress");
    expect(untaken.steps[3].status).toBe("active");
    // nothing credited to this account at all (too small to send after the bridge fee, say)
    const none = withdrawalRecord(wop3, { ...back, claimable: 0n, credited: undefined });
    expect(none.status).toBe("in_progress");
    expect(none.steps[3].title).not.toBe("Paid out");
  });

  it("shows a claim by hand from this browser as today when it took exactly this payout", () => {
    const here = withdrawalRecord(wop3, { ...back, claimable: 0n, claimed });
    expect(here.status).toBe("paid");
    expect(here.steps[3]).toMatchObject({ title: "Claim as USDC", status: "done" });
    expect(here.received).toEqual({ usdc: 2.45 });
  });

  it("shows one hand claim that took two payouts without a per-unstake amount", () => {
    const both = withdrawalRecord(wop3, { ...back, claimable: 0n, claimed: { ...claimed, taoClaimed: 2n * CREDIT, usdcOut: 4_900_000n } });
    expect(both.status).toBe("paid");
    expect(both.steps[3]).toMatchObject({ status: "done", detail: "Claimed together with your other payout: 4.90 USDC in all" });
    expect(both.received).toBeUndefined();
    expect(both.usdcAmount).toBeUndefined();
    // what this payout was credited isn't known yet: no amount rather than one that may be shared
    const unknown = withdrawalRecord(wop3, { ...back, claimable: 0n, credited: undefined, traceFailed: true, claimed });
    expect(unknown.status).toBe("paid");
    expect(unknown.received).toBeUndefined();
  });

  it("shows a claim made elsewhere without an amount, and says when it took other payouts too", () => {
    const elsewhere = withdrawalRecord(wop3, { ...back, claimable: 0n, claimedOnChain: { hash: H(31), at: new Date(), taoClaimed: CREDIT } });
    expect(elsewhere.status).toBe("paid");
    expect(elsewhere.steps[3].txUrl).toContain(H(31));
    expect(elsewhere.received).toBeUndefined();
    expect(elsewhere.usdcAmount).toBeUndefined();
    const both = withdrawalRecord(wop3, { ...back, claimable: 0n, claimedOnChain: { hash: H(31), at: new Date(), taoClaimed: 2n * CREDIT, shared: true } });
    expect(both.steps[3].detail).toBe("Claimed together with your other payout: 0.0198 TAO in all");
  });

  it("leaves a v2 unstake as it was, whatever the delivery facts say", () => {
    const r = withdrawalRecord(wop, { ...back, saleNowUsdc: 9_999_999n, now: new Date("2026-10-26T12:00:00Z") });
    expect(r.steps[3]).toMatchObject({ title: "Claim as USDC", status: "action", detail: "Your money is back on Base. Claim it as USDC" });
    expect(r.status).toBe("ready");
    expect(offersClaim(r)).toBe(true);
    expect(r.usdcAmount).toBe(2.5);
    const paid = withdrawalRecord(wop, { ...back, claimable: 0n, claimed: { ...claimed, taoClaimed: 2n * CREDIT } });
    expect(paid.received).toEqual({ usdc: 2.45 });
  });
});
