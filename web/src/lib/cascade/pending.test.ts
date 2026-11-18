import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { ClaimOp, DepositOp, Operation, WithdrawalOp } from "./oplog";
import { CONFIRMING, PENDING_SHOWN_MS, pendingEntries, pendingEntry, pendingRows, pendingTrail, receiptShows } from "./pending";

const ME: Address = "0x1234567890abcdef1234567890abcdef12345678";
const NOW = Date.UTC(2026, 9, 30, 12);
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const deposit = (over: Partial<DepositOp> = {}): DepositOp => ({
  id: "d1",
  kind: "deposit",
  v: 3,
  account: ME,
  createdAt: NOW - 60_000,
  usdcIn: 50_000_000n,
  targetTao: 194_610_000_000_000_000n,
  minTaoOut: 193_600_000_000_000_000n,
  priceUsd: 256.9,
  feesUsd: 0.25,
  hashes: { stake: H(1) },
  state: "sent",
  ...over,
});

const unstake = (over: Partial<WithdrawalOp> = {}): WithdrawalOp => ({
  id: "w1",
  kind: "withdrawal",
  account: ME,
  createdAt: NOW - 60_000,
  shares: 7n * 10n ** 16n,
  taoEstimate: 7n * 10n ** 16n,
  usdcEstimate: 17_410_000n,
  fee: 10n ** 14n,
  hash: H(2),
  state: "sent",
  ...over,
});

describe("pendingEntry", () => {
  it("a deposit that went through: the USDC staked, the TAO it should buy, its transaction", () => {
    expect(pendingEntry(deposit())).toEqual({
      notice: { kind: "deposit", id: "d1", usdc: 50, tao: 0.19461 },
      createdAt: new Date(NOW - 60_000),
      txUrl: `https://basescan.org/tx/${H(1)}`,
    });
  });

  it("a deposit of wallet TAO (v2's deposit call): its exact TAO, no USDC", () => {
    const e = pendingEntry(deposit({ v: undefined, usdcIn: 0n, targetTao: 10n ** 17n, hashes: { approveTao: H(3), deposit: H(4) } }));
    expect(e?.notice).toEqual({ kind: "deposit", id: "d1", tao: 0.1 });
    expect(e?.txUrl).toBe(`https://basescan.org/tx/${H(4)}`);
  });

  it("an unstake that went through: its TAO and USDC estimates, its request", () => {
    expect(pendingEntry(unstake())).toEqual({
      notice: { kind: "unstake", id: "w1", tao: 0.07, usdc: 17.41 },
      createdAt: new Date(NOW - 60_000),
      txUrl: `https://basescan.org/tx/${H(2)}`,
    });
  });

  it("a v3.2 unstake that receives TAO: its TAO estimate alone, no USDC it never asked for (Task 59a)", () => {
    expect(pendingEntry(unstake({ usdcEstimate: 0n, keepTao: true }))?.notice).toEqual({ kind: "unstake", id: "w1", tao: 0.07, keepTao: true });
  });

  it("nothing for what hasn't gone through, was taken back out, or isn't a deposit or unstake", () => {
    for (const state of ["running", "needs-you", "failed"] as const) {
      expect(pendingEntry(deposit({ state }))).toBeNull();
      expect(pendingEntry(unstake({ state }))).toBeNull();
    }
    expect(pendingEntry(deposit({ cancelled: { hash: H(5), at: NOW } }))).toBeNull();
    expect(pendingEntry(unstake({ cancelled: { hash: H(5), at: NOW } }))).toBeNull();
    const claim: ClaimOp = { id: "c1", kind: "claim", account: ME, createdAt: NOW, amount: 1n, keepTao: false, minUsdc: 0n, hashes: { claim: H(6) }, state: "sent" };
    expect(pendingEntry(claim)).toBeNull();
  });
});

describe("pendingEntries", () => {
  const ops: Operation[] = [
    deposit({ id: "new", createdAt: NOW - 60_000 }),
    deposit({ id: "older", createdAt: NOW - 3 * 60 * 60_000 }),
    deposit({ id: "lastWeek", createdAt: NOW - 7 * 24 * 60 * 60_000 }),
    deposit({ id: "stopped", state: "needs-you" }),
    unstake(),
  ];

  it("shows this browser's deposits sent in the last day, newest first, while the list hasn't been read", () => {
    expect(pendingEntries(ops, "deposit", undefined, NOW).map((e) => e.notice.id)).toEqual(["new", "older"]);
    expect(pendingEntries(ops, "withdrawal", undefined, NOW).map((e) => e.notice.id)).toEqual(["w1"]);
    expect(PENDING_SHOWN_MS).toBe(24 * 60 * 60_000);
  });

  it("drops each one the list read from the chain holds, by id: an entry and its record never show together", () => {
    expect(pendingEntries(ops, "deposit", [{ id: "older" }], NOW).map((e) => e.notice.id)).toEqual(["new"]);
    expect(pendingEntries(ops, "deposit", [{ id: "new" }, { id: "older" }, { id: "chain-0xabc" }], NOW)).toEqual([]);
    // a list read before the deposit was sent (cached from another page) doesn't hold it: it still shows
    expect(pendingEntries(ops, "deposit", [], NOW).map((e) => e.notice.id)).toEqual(["new", "older"]);
  });
});

describe("receiptShows", () => {
  const entry = pendingEntry(deposit());
  const q = { isPending: false, isFetching: false, isError: false };

  it("the record once the list read from the chain has it", () => {
    expect(receiptShows({ ...q, record: { id: "d1" }, entry })).toBe("record");
  });

  it("this browser's own entry, unconfirmed, until then: while the list loads, or a list read before it was sent", () => {
    expect(receiptShows({ ...q, isPending: true, record: undefined, entry })).toBe("pending");
    expect(receiptShows({ ...q, isFetching: true, record: null, entry })).toBe("pending");
  });

  it("with no entry of its own: loading, then not found", () => {
    expect(receiptShows({ ...q, isPending: true, record: undefined, entry: null })).toBe("loading");
    expect(receiptShows({ ...q, isFetching: true, record: null, entry: null })).toBe("loading");
    expect(receiptShows({ ...q, record: null, entry: null })).toBe("not-found");
  });

  it("a failed read is said, with the entry above it when there is one", () => {
    expect(receiptShows({ ...q, isError: true, record: undefined, entry: null })).toBe("error");
    expect(receiptShows({ ...q, isError: true, record: { id: "d1" }, entry: null })).toBe("error");
    expect(receiptShows({ ...q, isError: true, record: undefined, entry })).toBe("pending-error");
  });
});

describe("pendingTrail: a receipt's own steps before anything is read from the chain", () => {
  const steps = (op: Operation, x?: { payoutDelayS?: number }) => {
    const entry = pendingEntry(op);
    if (!entry) throw new Error("no entry");
    return pendingTrail(entry, x);
  };

  it("an unstake: its request confirming, then what is ahead, the safety wait named", () => {
    const s = steps(unstake(), { payoutDelayS: 86_400 });
    expect(s.map((x) => [x.key, x.status])).toEqual([["request", "active"], ["unstake", "pending"], ["return", "pending"], ["claim", "pending"]]);
    expect(s[0]).toMatchObject({ title: "Request your unstake", detail: CONFIRMING, txUrl: `https://basescan.org/tx/${H(2)}` });
    expect(s[1].detail).toBe("Leaves Base with the next batch, then the bridge (usually 20–30 minutes)");
    expect(s[2].detail).toBe("Starts after a 24-hour safety wait on Bittensor");
    expect(s[3]).toMatchObject({ title: "USDC to your wallet", detail: "Sold for USDC on Base and sent to your wallet automatically" });
    // the wait's length not known to the site: still said to be there; a deployment without one: nothing promised
    expect(steps(unstake())[2].detail).toBe("Starts after a safety wait on Bittensor");
    expect(steps(unstake(), { payoutDelayS: 0 })[2].detail).toBeUndefined();
    // nothing but the step it sent claims anything: no step is done, none has a time
    expect(s.some((x) => x.status === "done" || x.at !== undefined)).toBe(false);
  });

  it("an unstake asked as TAO ends in a claim of TAO, not a sale", () => {
    const s = steps(unstake({ keepTao: true } as Partial<WithdrawalOp>), { payoutDelayS: 86_400 });
    expect(s[3]).toMatchObject({ title: "Claim your TAO", detail: "Arrives on Base as TAO, for you to claim" });
    expect(pendingRows(pendingEntry(unstake({ keepTao: true } as Partial<WithdrawalOp>))!.notice)).toEqual([["You will receive", "TAO on Base, to claim"]]);
  });

  it("a deposit: the transaction it sent confirming (the swap; for TAO already in the wallet, the deposit)", () => {
    const usdc = steps(deposit());
    expect(usdc.map((x) => [x.key, x.status])).toEqual([["swap", "active"], ["deposit", "pending"], ["bridge", "pending"], ["stake", "pending"]]);
    expect(usdc[0].detail).toBe(CONFIRMING);
    expect(usdc[2].detail).toBe("Leaves Base with the next batch, then the bridge (usually 20–30 minutes)");
    const tao = steps(deposit({ usdcIn: 0n }));
    expect(tao.map((x) => [x.key, x.status])).toEqual([["swap", "done"], ["deposit", "active"], ["bridge", "pending"], ["stake", "pending"]]);
    expect(tao[1].detail).toBe(CONFIRMING);
    // the rows are the confirmed receipt's, an estimate said to be one and wallet TAO's exact
    expect(pendingRows(pendingEntry(deposit())!.notice)[0][0]).toBe("TAO in this deposit");
    expect(pendingRows(pendingEntry(deposit())!.notice)[0][1]).toMatch(/^about [0-9.]+ TAO$/);
    expect(pendingRows(pendingEntry(deposit({ usdcIn: 0n }))!.notice)[0][1]).toMatch(/^[0-9.]+ TAO$/);
  });
});
