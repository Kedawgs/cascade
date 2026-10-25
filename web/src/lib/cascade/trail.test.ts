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
  closesAt: new Date("2026-10-25T10:10:00Z"),
  waitingForMinimum: false,
  stillOpen: true,
};

const statuses = (r: { steps: { status: string }[] }) => r.steps.map((s) => s.status);

describe("deposit trail", () => {
  it("waits in the open batch, saying when it closes", () => {
    const r = depositRecord(op, base);
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[2].detail).toMatch(/10:10 UTC/);
    expect(r.cancellableWei).toBe(78_000_000_000_000_000n);
    expect(r.amountUsd).toBe(20);
    expect(r.status).toBe("in_progress");
  });

  it("is on the bridge once the batch has closed", () => {
    const r = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false });
    expect(statuses(r)).toEqual(["done", "done", "active", "pending"]);
    expect(r.steps[2].detail).toMatch(/bridge/i);
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

  it("explains a vault still waiting for the 0.02-TAO minimum", () => {
    const delivered = { at: new Date(), txHash: H(9), outcome: "deposited" as const };
    const r = depositRecord(op, { ...base, openBatchId: 4n, stillOpen: false, delivered, waitingForMinimum: true });
    expect(r.steps[3].status).toBe("active");
    expect(r.steps[3].detail).toMatch(/0\.02 TAO/);
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
    expect(r.steps[2].detail).toMatch(/11:35 UTC/);
    const flying = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout: { txHash: H(4), messageId: H(6), state: 1, at: new Date() } });
    expect(flying.steps[2].txUrl).toContain(H(6));
  });

  it("asks the user to claim once the TAO is back on Base, then shows it paid", () => {
    const redeemed = { at: new Date(), txHash: H(9), outcome: "redeemed" as const, taoWei: 99n * 10n ** 14n };
    const payout = { txHash: H(4), messageId: H(6), state: 2 as const, at: new Date() };
    const ready = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 99n * 10n ** 14n });
    expect(statuses(ready)).toEqual(["done", "done", "done", "action"]);
    expect(ready.status).toBe("ready");
    const paid = withdrawalRecord(wop, { ...wbase, openBatchId: 6n, stillOpen: false, delivered: redeemed, payout, claimable: 0n, claimed: { hash: H(11), at: new Date() } });
    expect(paid.status).toBe("paid");
    expect(statuses(paid)).toEqual(["done", "done", "done", "done"]);
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
