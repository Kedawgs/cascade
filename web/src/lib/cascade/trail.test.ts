import { describe, expect, it } from "vitest";
import type { DepositOp, WithdrawalOp } from "./oplog";
import { chainOnlyDeposit, type DepositFacts, depositRecord, type WithdrawalFacts, withdrawalRecord } from "./trail";

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

describe("deposit trail", () => {
  it("waits in the open batch, saying when it closes", () => {
    const r = depositRecord(op, base);
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[2].detail).toMatch(/10:10 AM/);
    expect(r.cancellableWei).toBe(78_000_000_000_000_000n);
    expect(r.amountUsd).toBe(20);
    expect(r.status).toBe("in_progress");
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
    expect(r.retryable).toBe(true);
    expect(r.nothingSent).toBe(true);
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

describe("withdrawal trail", () => {
  it("goes from requested to unstaked to returning", () => {
    expect(statuses(withdrawalRecord(wop, wbase))).toEqual(["done", "active", "pending", "pending"]);
    const redeemed = { at: new Date("2026-10-25T10:35:00Z"), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const r = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed });
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[2].detail).toMatch(/11:35 AM/);
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

  it("marks a failed payout message and a skipped redeem", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 1n };
    const failed = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout: { txHash: H(4), messageId: H(6), state: 3, at: new Date() } });
    expect(failed.steps[2].status).toBe("failed");
    const skipped = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: { at: new Date(), txHash: H(9), outcome: "skipped" } });
    expect(skipped.steps[1].status).toBe("failed");
  });

  it("lets a request still in the open batch be cancelled", () => {
    expect(withdrawalRecord(wop, wbase).cancellableShares).toBe(10n ** 22n);
  });
});
